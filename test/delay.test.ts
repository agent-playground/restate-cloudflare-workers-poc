// src/utils/delay.ts — 可注入延遲的單元測試（Issue #67，為既有行為補測試）。
//
// 涵蓋三種既有行為契約：
// 1. 預設實作：delay(ms) 排入一個延遲 ms 的 setTimeout，且只在計時器觸發後 resolve。
// 2. 注入：setDelayImpl 之後 delay 使用注入的實作，完全不建立計時器。
// 3. 還原：resetDelayImpl 之後回到預設的真實計時器路徑。
//
// 前提：test/loader/test-setup.mjs 在測試啟動時全域注入零延遲實作。需要預設
// 實作的測試會先顯式呼叫 resetDelayImpl()，並在 afterEach 還原零延遲注入，
// 避免本檔案對模組單例（let impl）的改動洩漏給後續測試。
//
// fake timers 的做法（零新增相依）：t.mock.timers.enable() 提供受控時鐘
// （tick 才觸發），再以 t.mock.method 在其外一層間接 spy，就能直接斷言
// 「setTimeout 被呼叫、延遲參數等於 ms」，再用「tick 前不 resolve、tick 後
// 才 resolve」斷言等待語意——不需要真的睡眠，也不依賴未提供的 pending API。
import { afterEach, describe, it } from "node:test";
import { delay, resetDelayImpl, setDelayImpl } from "../src/utils/delay";

// 把微任務佇列排空：讓已 resolve 的 promise 的 .then 回調有機會執行完。
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("src/utils/delay — 可注入延遲", () => {
  afterEach(() => {
    // 還原 test-setup 的零延遲注入（每個 it 自行決定是否 resetDelayImpl；
    // 離開 it 時一律恢復套件的全域前提）。
    setDelayImpl(() => Promise.resolve());
  });

  describe("1. 預設實作：真實計時器", () => {
    it("delay(ms) 排入延遲 ms 的 setTimeout，且只在計時器觸發後 resolve", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const setTimeoutSpy = t.mock.method(globalThis, "setTimeout");
      resetDelayImpl(); // 撤銷 test-setup 的零延遲注入 → 回到預設實作

      let resolved = false;
      const settled = delay(500).then((value) => {
        resolved = true;
        return value;
      });

      await flushMicrotasks();
      // 計時器被排入：恰一次 setTimeout 呼叫，延遲參數 = 500
      t.assert.equal(setTimeoutSpy.mock.calls.length, 1);
      t.assert.equal(setTimeoutSpy.mock.calls[0].arguments[1], 500);
      // 尚未觸發 → promise 未 resolve
      t.assert.equal(resolved, false);

      // 差 1ms 才到 500：仍不 resolve（延遲不少於 500ms）
      t.mock.timers.tick(499);
      await flushMicrotasks();
      t.assert.equal(resolved, false);

      // 正好 500ms：觸發後才 resolve，值為 undefined
      t.mock.timers.tick(1);
      t.assert.equal(await settled, undefined);
      t.assert.equal(resolved, true);
    });

    it("delay(ms) 回傳 Promise（非同步語意，同步階段不擲錯）", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      resetDelayImpl();

      const p = delay(100); // 呼叫當下不得同步拋出
      t.assert.equal(typeof p.then, "function");
      t.mock.timers.tick(100);
      t.assert.equal(await p, undefined);
    });
  });

  describe("2. setDelayImpl 注入", () => {
    it("注入後 delay 使用注入實作（ms 轉递给注入實作），且不建立任何計時器", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const setTimeoutSpy = t.mock.method(globalThis, "setTimeout");

      const received: number[] = [];
      setDelayImpl((ms) => {
        received.push(ms);
        return Promise.resolve();
      });

      // 直接 resolve（無需 tick 任何時間），代表零延遲注入生效
      t.assert.equal(await delay(5000), undefined);
      t.assert.deepStrictEqual(received, [5000]);
      // 「不建立真實 timer」：整個呼叫期間 setTimeout 一次都沒被排入
      t.assert.equal(setTimeoutSpy.mock.calls.length, 0);
    });

    it("重複注入以最後一次為準（後者覆蓋前者）", async (t) => {
      const calls: string[] = [];
      setDelayImpl(() => {
        calls.push("first");
        return Promise.resolve();
      });
      setDelayImpl(() => {
        calls.push("second");
        return Promise.resolve();
      });

      await delay(1);
      t.assert.deepStrictEqual(calls, ["second"]);
    });

    it("注入實作的 rejection 原樣传播（delay 直接回傳 impl 的 promise）", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const setTimeoutSpy = t.mock.method(globalThis, "setTimeout");
      const boom = new Error("boom");
      setDelayImpl(() => Promise.reject(boom));

      await t.assert.rejects(() => delay(10), (err) => err === boom);
      t.assert.equal(setTimeoutSpy.mock.calls.length, 0);
    });
  });

  describe("3. resetDelayImpl 還原", () => {
    it("還原後回到預設實作：注入實作不再被呼叫，改由 setTimeout 排程並等待觸發", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const setTimeoutSpy = t.mock.method(globalThis, "setTimeout");

      let injectedCalled = false;
      setDelayImpl(() => {
        injectedCalled = true;
        return Promise.resolve();
      });
      resetDelayImpl();

      let resolved = false;
      const settled = delay(200).then(() => {
        resolved = true;
      });

      t.assert.equal(injectedCalled, false); // 已被替換回預設實作
      t.assert.equal(setTimeoutSpy.mock.calls.length, 1); // 重新走 setTimeout 排程
      t.assert.equal(setTimeoutSpy.mock.calls[0].arguments[1], 200);
      await flushMicrotasks();
      t.assert.equal(resolved, false); // 並維持「等待計時器觸發才 resolve」的預設語意
      t.mock.timers.tick(200);
      await settled;
      t.assert.equal(resolved, true);
    });

    it("連續兩次 resetDelayImpl 冪等：行為仍是預設計時器路徑", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const setTimeoutSpy = t.mock.method(globalThis, "setTimeout");
      resetDelayImpl();
      resetDelayImpl();

      const p1 = delay(10);
      const p2 = delay(20);
      t.assert.equal(setTimeoutSpy.mock.calls.length, 2);
      t.assert.equal(setTimeoutSpy.mock.calls[0].arguments[1], 10);
      t.assert.equal(setTimeoutSpy.mock.calls[1].arguments[1], 20);

      t.mock.timers.tick(10);
      t.assert.equal(await p1, undefined); // 10ms 的先到
      t.mock.timers.tick(10);
      t.assert.equal(await p2, undefined); // 20ms 的後到
    });
  });
});

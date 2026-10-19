// src/utils/payment_new.ts — processPayment 單元測試（既有行為回歸防護）。
import { afterEach, describe, it } from "node:test";
import { processPayment } from "../src/utils/payment_new";
import { setDelayImpl } from "../src/utils/delay";

describe("processPayment()（mock 支付閘道）", () => {
  it("card_success 回傳 true", async (t) => {
    t.assert.equal(await processPayment(100, "card_success"), true);
  });

  it("card_decline 丟出含方式名稱的錯誤", async (t) => {
    await t.assert.rejects(
      () => processPayment(100, "card_decline"),
      /^Error: Payment declined \(Method: card_decline\)$/
    );
  });

  it("card_error 丟出 Gateway timeout", async (t) => {
    await t.assert.rejects(() => processPayment(100, "card_error"), /^Error: Gateway timeout$/);
  });

  it(
    "邊界（既有行為）：金額完全不驗證——0、負數、非數字標識之金額照樣成功；" +
      "金額只進 log（POC 模擬閘道，決策完全取決於 paymentMethodId）",
    async (t) => {
      t.assert.equal(await processPayment(0, "anything_else"), true);
      t.assert.equal(await processPayment(-999, "card_success"), true);
    }
  );
});

// Issue #88 盤點缺口：延遲是否經可注入的 delay() 走——既有測試只驗回傳值/拋錯，
// 「processPayment 以 delay(500) 模擬外部延遲、且延遲發生在決策之前」從未斷言
// （test-setup.mjs 全域歸零後，500 這個接線值與 await 語意對所有既有斷言不可見）。
describe("processPayment() — 延遲接線（經可注入 delay()）", () => {
  afterEach(() => {
    // 還原 test-setup 的零延遲全域注入，避免本 block 對 delay 模組單例的改動洩漏。
    setDelayImpl(() => Promise.resolve());
  });

  // 把微任務佇列排空：讓已 resolve 的 promise 的 .then 回調有機會執行完。
  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  it("成功路徑恰呼叫 delay() 一次，且傳遞 500（模擬閘道延遲的接線值）", async (t) => {
    const received: number[] = [];
    setDelayImpl((ms) => {
      received.push(ms);
      return Promise.resolve();
    });

    t.assert.equal(await processPayment(100, "card_success"), true);
    t.assert.deepStrictEqual(received, [500]);
  });

  it("失敗路徑（card_decline／card_error）仍先支付延遲——delay() 發生在決策之前", async (t) => {
    const received: number[] = [];
    setDelayImpl((ms) => {
      received.push(ms);
      return Promise.resolve();
    });

    await t.assert.rejects(() => processPayment(100, "card_decline"));
    t.assert.deepStrictEqual(received, [500]); // 丟錯前 delay 已被呼叫

    received.length = 0;
    await t.assert.rejects(() => processPayment(100, "card_error"));
    t.assert.deepStrictEqual(received, [500]);
  });

  it("必須等待 delay() 的 promise resolve 之後才回傳（await 接線，非 fire-and-forget）", async (t) => {
    let delayCalls = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    setDelayImpl(() => {
      delayCalls++;
      return gate; // 不自行 resolve：由測試決定延遲何時「結束」
    });

    let settled = false;
    const payment = processPayment(100, "card_success").then((value) => {
      settled = true;
      return value;
    });

    await flushMicrotasks();
    t.assert.equal(delayCalls, 1); // delay() 已同步經注入路徑呼叫
    t.assert.equal(settled, false); // gate 未 resolve → 不得提前回傳

    releaseGate();
    t.assert.equal(await payment, true);
    t.assert.equal(settled, true);
  });
});

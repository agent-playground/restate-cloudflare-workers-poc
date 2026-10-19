// src/utils/email.ts — sendEmail 單元測試（既有行為：純模擬、永不失敗）。
import { afterEach, describe, it } from "node:test";
import { sendEmail } from "../src/utils/email";
import { setDelayImpl } from "../src/utils/delay";

// 把微任務佇列排空：讓已 resolve 的 promise 的 .then 回調有機會執行完。
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("sendEmail()（模擬郵件服務）", () => {
  it("正常呼叫 resolve 為 undefined，不拋錯", async (t) => {
    t.assert.equal(await sendEmail("user@example.com", "Subject", "Body"), undefined);
  });

  it("邊界（既有行為）：空字串/特殊字元收件人不驗證，照樣成功", async (t) => {
    t.assert.equal(await sendEmail("", "", ""), undefined);
    t.assert.equal(await sendEmail("中文主旨 <script>", "subj\r\ne", "body"), undefined);
  });

  // Issue #88 盤點缺口：延遲是否經可注入的 delay() 走——既有測試只驗回傳值，
  // 「sendEmail 以 delay(200) 模擬網路延遲且完成前必等待其 resolve」從未斷言。
  describe("延遲接線（經可注入 delay()）", () => {
    afterEach(() => {
      // 還原 test-setup 的零延遲全域注入，避免對 delay 模組單例的改動洩漏。
      setDelayImpl(() => Promise.resolve());
    });

    it("恰呼叫 delay() 一次，且傳遞 200（模擬網路延遲的接線值）", async (t) => {
      const received: number[] = [];
      setDelayImpl((ms) => {
        received.push(ms);
        return Promise.resolve();
      });

      t.assert.equal(await sendEmail("user@example.com", "Subject", "Body"), undefined);
      t.assert.deepStrictEqual(received, [200]);
    });

    it("必須等待 delay() 的 promise resolve 之後才完成（await 接線，非 fire-and-forget）", async (t) => {
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
      const mail = sendEmail("user@example.com", "Subject", "Body").then(() => {
        settled = true;
      });

      await flushMicrotasks();
      t.assert.equal(delayCalls, 1); // delay() 已同步經注入路徑呼叫
      t.assert.equal(settled, false); // gate 未 resolve → 不得提前完成

      releaseGate();
      await mail;
      t.assert.equal(settled, true);
    });
  });
});

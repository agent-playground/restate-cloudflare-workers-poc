// test/game_manager_reset_resale.test.ts — 回合重置（auto-reset）的規格測試。
//
// 【產品裁定 2026-10-19】本專案是 PoC：湊滿 50 SOLD 觸發的 auto-reset 是「回合重置」，
// **全部清空、已售出（SOLD）票不退款**，重置後同一座位可在新回合再次售出——這是
// 設計行為，不是缺陷。AP1 分析（docs/research/76-checkout-compensation-concurrency-analysis.md
// §3.1）原列為 R1／P0 並建議 WI-2 修復；WI-2 已被否決，不會開 agent-fix-bug。
//
// 機制：GameManager.reset 對 seat-1..50 發出無身分的 release()（src/game_manager.ts），
// Ticket.release 的守衛只在帶 userId 時才檢查（src/game.ts）→ SOLD 票被清回 AVAILABLE。
//
// 本檔把這個行為釘成規格（Issue #87 交付時以 characterization 釘住，裁定後改為規格）：
// 若日後有人把「重置後同座位可再售」當成 bug 修掉，這條測試會紅——那必須先改產品裁定。
// Issue #87 原本以 it.skip 交付的「重置後不得再售」應然斷言已移除：它斷言的是被否決的需求，
// 保留會誤導日後的工作項把它 un-skip。
import { describe, it } from "node:test";
import { createIntegration } from "./helpers/integration";
import type { TicketState } from "../src/game";

/** 走完整 checkout saga（reserve→扣款→confirm→SOLD 回寫→發信）賣出一席。 */
async function sellSeat(
  itg: ReturnType<typeof createIntegration>,
  seatIndex: number,
  userId: string
): Promise<unknown> {
  return await itg.checkout.process({
    ticketId: `seat-${seatIndex}`,
    userId,
    paymentMethodId: "card_success",
  });
}

/** 取 Ticket 槽真值（未寫入時 undefined）。 */
function ticketState(itg: ReturnType<typeof createIntegration>, key: string): TicketState {
  return itg.stateOf("Ticket", key).data.state as TicketState;
}

describe("回合重置（auto-reset）規格：全部清空、SOLD 不退款（PoC 產品裁定 2026-10-19）", () => {
  // source: Issue #87（AP3）；AP1 報告 §3.1 E1；產品裁定見檔頭。
  it("50 席完整售出→投遞 reset→seat-1 在新回合再次完整 checkout 成功（設計行為）", async (t) => {
    const itg = createIntegration();

    // 第一輪：50 席各自走「完整」checkout saga——每席都真實扣款、confirm、發信。
    // （測試執行期延遲已由 test/loader/test-setup.mjs 歸零，見該檔註解。）
    for (let i = 1; i <= 50; i++) {
      t.assert.equal(await sellSeat(itg, i, `user-${i}`), "Booking Confirmed");
    }

    // 第 50 筆 SOLD 回寫使 soldCount 湊滿 50，SeatMap.set 觸發 auto-reset
    // （src/game.ts:154–167）：view 同步清回 AVAILABLE，GameManager.reset 進
    // fire-and-forget pending queue——此刻真值尚未被碰。
    const beforeDelivery = ticketState(itg, "seat-1");
    t.assert.equal(beforeDelivery.status, "SOLD", "投遞前 user-1 的真值應為 SOLD");
    t.assert.equal(beforeDelivery.reservedBy, "user-1");
    t.assert.equal(
      itg.world.pendingSends.some((s) => s.service === "GameManager" && s.handler === "reset"),
      true,
      "reset 應已在 pending queue（auto-reset 由第 50 筆 SOLD 觸發）"
    );

    // 投遞全部待辦：GameManager.reset → SeatMap.reset ＋ 50 張「無身分」release()。
    await itg.drain();

    // 回合重置全清：已付款（SOLD）票被無身分 release 清回 AVAILABLE（src/game.ts
    // 的守衛只在 userId !== undefined 時檢查——重置路徑刻意帶過）。
    const afterReset = ticketState(itg, "seat-1");
    t.assert.equal(afterReset.status, "AVAILABLE", "規格：回合重置把 SOLD 票清回 AVAILABLE");
    t.assert.equal(afterReset.reservedBy, null);

    // 新回合：mallory 對 seat-1 再次「完整」checkout——reserve、扣款、confirm 全程成功。
    t.assert.equal(
      await sellSeat(itg, 1, "mallory"),
      "Booking Confirmed",
      "規格：重置後同座位可在新回合再次售出"
    );

    // 核心斷言：同一座位（seat-1）出現兩次 confirm 真實 handler 呼叫且都成功
    // （success 由往返結果釘：user-1 的成交見 reset 前 SOLD 真值；
    //  mallory 的成交見下方最終真值與 Booking Confirmed）。
    const seat1Confirms = itg.world.calls.filter(
      (c) => c.service === "Ticket" && c.key === "seat-1" && c.handler === "confirm"
    );
    t.assert.equal(seat1Confirms.length, 2, "seat-1 應恰有兩次 confirm 呼叫");
    t.assert.deepStrictEqual(
      seat1Confirms.map((c) => c.args[0]),
      ["user-1", "mallory"],
      "兩次 confirm 分別屬第一輪買家與重置後買家"
    );

    // 資金與下游：兩輪付款與發信都執行（SOLD 不退款是產品裁定，無退款路徑是預期），
    // 最終真值 SOLD 給新回合買家 mallory。
    const seat1CheckoutRuns = itg.world.runs.filter(
      (r) => r === "Checkout.process-payment" || r === "Checkout.send-email"
    );
    t.assert.equal(seat1CheckoutRuns.length, 102, "51 次結帳 × (付款+發信) 全執行");
    const finalState = ticketState(itg, "seat-1");
    t.assert.equal(finalState.status, "SOLD");
    t.assert.equal(finalState.reservedBy, "mallory");
  });
});

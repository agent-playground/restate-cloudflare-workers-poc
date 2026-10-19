// test/game_manager_reset_resale.test.ts — Issue #87（AP3）：釘住 auto-reset 雙重銷售（R1）。
//
// 依 AP1 分析（docs/research/76-checkout-compensation-concurrency-analysis.md §3.1 R1）：
// 湊滿 50 SOLD 觸發的 auto-reset 經 GameManager.reset 對 seat-1..50 發出「無身分的
// release()」（src/game_manager.ts:15–17），Ticket.release 的守衛只在帶 userId 時才
// 檢查（src/game.ts:92–99）→ 已付款（SOLD）票被清回 AVAILABLE，同一座位可再被完整
// 售出（雙重銷售、首位買家無退款）。
//
// 既有覆蓋缺口：
// - test/game_manager.test.ts 只驗證 reset 有發出 release（呼叫形状 characterization）；
// - test/game.test.ts:182–188 只釘 handler 層「無參數 release 會釋放 SOLD」；
// - test/integration_scenarios.test.ts S6 只釘「重置鏈條序列化投遞」；
// 「重置後同座位第二次完整 checkout 成功＝雙重銷售」的業務後果未曾被釘住。
//
// 本檔以既有整合式 harness（test/helpers/integration.ts，真實 handler 接線）補兩條測試：
//   1. characterization（綠燈）：50 席完整售出 → 投遞 reset → seat-1 再次完整 checkout
//      成功，斷言同一座位兩次 confirm 成功——誠實釘住現行缺陷，供修復後翻綠比對。
//   2. 應然斷言（it.skip 交付）：「重置後已 SOLD 的座位不得被再次售出」——現行實作
//      必紅（非測試自身錯誤），依 docs/29 agent-add-tests 規則以 it.skip 保留完整斷言，
//      建議另開 agent-fix-bug（AP1 報告 WI-2；修法涉商業規則，需人裁定）。
import { describe, it } from "node:test";
import { createIntegration, TerminalError } from "./helpers/integration";
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

describe("Issue #87 R1——auto-reset 雙重銷售（characterization：釘住現行缺陷）", () => {
  // source: Issue #87 驗收條件 1；AP1 報告 §3.1 E1（docs/research/76-checkout-compensation-concurrency-analysis.md）
  it("50 席完整售出→投遞 reset→seat-1 再次完整 checkout 成功：同一座位兩次 confirm（現行缺陷）", async (t) => {
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

    // 機制層釘選：已付款（SOLD）票被無身分 release 清回 AVAILABLE（src/game.ts:92–99
    // 的守衛只在 userId !== undefined 時檢查——重置路徑帶過）。
    const afterReset = ticketState(itg, "seat-1");
    t.assert.equal(afterReset.status, "AVAILABLE", "現行行為：SOLD 票被 reset 回收");
    t.assert.equal(afterReset.reservedBy, null);

    // 業務後果：mallory 對 seat-1 再次「完整」checkout——reserve、扣款、confirm
    // 全程成功，現行實作無法拒絕。
    t.assert.equal(
      await sellSeat(itg, 1, "mallory"),
      "Booking Confirmed",
      "現行缺陷：重置後同座位第二次完整結帳成功"
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

    // 資金與下游後果釘選：seat-1 上 process-payment 與 send-email 各執行兩次
    // （user-1 的 100 元滯留、全 repo 無退款路徑——AP1 §1 第 1 點），
    // 最終真值 SOLD 給 mallory（首位買家失去座位）。
    const seat1CheckoutRuns = itg.world.runs.filter(
      (r) => r === "Checkout.process-payment" || r === "Checkout.send-email"
    );
    t.assert.equal(seat1CheckoutRuns.length, 102, "51 次結帳 × (付款+發信) 全執行");
    const finalState = ticketState(itg, "seat-1");
    t.assert.equal(finalState.status, "SOLD");
    t.assert.equal(finalState.reservedBy, "mallory");
  });
});

describe("Issue #87 R1——應然：重置後已 SOLD 的座位不得被再次售出", () => {
  // source: Issue #87 驗收條件 2；AP1 報告 §3.1（修復方向 WI-2：release() 無參數
  // 呼叫的 SOLD 特例需人類裁定商業規則後由 agent-fix-bug 實作）。
  //
  // 本測試在現行實作上必紅（非測試自身錯誤）：無身分 release 會把 SOLD 清回
  // AVAILABLE，第二次 checkout 完整成功。依 docs/29 agent-add-tests 規則以 it.skip
  // 交付——斷言完整保留，修復（WI-2）合併後 un-skip 應翻綠。
  it.skip("auto-reset 投遞後：SOLD 真值保留、同座位再次結帳必須失敗", async (t) => {
    const itg = createIntegration();

    for (let i = 1; i <= 50; i++) {
      t.assert.equal(await sellSeat(itg, i, `user-${i}`), "Booking Confirmed");
    }
    await itg.drain(); // 投遞 auto-reset

    // 應然 ①：重置不得抹除已收款（SOLD）交易——真值仍屬首位買家。
    const afterReset = ticketState(itg, "seat-1");
    t.assert.equal(afterReset.status, "SOLD", "應然：SOLD 票不得被無身分 release 清回收賣");
    t.assert.equal(afterReset.reservedBy, "user-1");

    // 應然 ②：同座位第二次完整結帳必須失敗（TerminalError），不得再成交。
    await t.assert.rejects(
      async () => await sellSeat(itg, 1, "mallory"),
      (err: Error) => err instanceof TerminalError,
      "應然：已售出座位不得被再次售出"
    );

    // 應然 ③：同一座位 confirm 成功至多一次；最終真值未被第二買家取得。
    const seat1Confirms = itg.world.calls.filter(
      (c) => c.service === "Ticket" && c.key === "seat-1" && c.handler === "confirm"
    );
    t.assert.equal(seat1Confirms.length, 1, "應然：seat-1 僅一次 confirm");
    const finalState = ticketState(itg, "seat-1");
    t.assert.equal(finalState.status, "SOLD");
    t.assert.equal(finalState.reservedBy, "user-1");
  });
});

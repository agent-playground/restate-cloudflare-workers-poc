// test/seatmap_conditional_write.test.ts — Issue #82（AP5）：SeatMap.set(AVAILABLE) 條件寫入。
//
// 依據：
//   - docs/research/76-checkout-compensation-concurrency-analysis.md §3.3（E3／R3）、§5.2 WI-5；
//   - Issue #82 驗收標準（AP3 應然斷言 un-skip 綠燈、`npm test` 全綠）。
//
// 缺陷（#22 修復殘留的 TOCTOU，Issue #80 已以 checkout_view_toctou.test.ts 釘住）：
// `SeatMap.set` 為無條件 last-writer-wins 覆寫（src/game.ts:132–135）。補償路徑
// `ticket.release(userId)` 在「檢查當下」回 true 後，若第三人已於視窗內合法接管座位，
// 過期的 `seatMap.set(AVAILABLE)` 回寫仍會覆蓋对方的 view 寫入，製造
// 「view=AVAILABLE、真值為他人 RESERVED/SOLD」的幽靈可售席位。
//
// 應然（WI-5 條件寫入）：`set` 降級為 AVAILABLE 的寫入必須附前置條件——於 SeatMap handler
// 的**同一次執行**內（虛擬物件 exclusive，檢查與寫入之間不再有跨物件視窗）讀取該席 Ticket
// 真值；真值仍由他人持有（RESERVED/SOLD）時**丟棄該寫入並回傳 false**，視圖收斂交給
// 下一次真值事件。合法補償（release 成功且未被接管）不受影響。
//
// 交付形態（agent-fix-bug 規則）：在既有實作上紅燈的測試以 it.skip 提交、斷言完整保留
// （紅燈證據見 Issue #82 留言／PR 描述）；02-impl 層連同修復一併 un-skip。
import { describe, it } from "node:test";
import { createIntegration, TerminalError } from "./helpers/integration";
import type { IntegrationWorld } from "./helpers/integration";
import type { TicketState } from "../src/game";

const SEAT = "seat-12";

function viewOf(itg: IntegrationWorld): string | undefined {
  const map = itg.stateOf("SeatMap", "global").data.map as Record<string, string>;
  return map[SEAT];
}

describe("Issue #82 R3 修復——SeatMap.set(AVAILABLE) 條件寫入（WI-5）", () => {
  // 反證錨點（現行綠、修復後亦須綠）：真值 AVAILABLE（本人 release 成功、无人接管）時，
  // 合法的補償回寫必須照常生效——條件寫入不得把正常補償路徑也關掉。
  it("條件成立：本人 release 成功後回寫 AVAILABLE 照常生效（合法補償不 Regression）", async (t) => {
    const itg = createIntegration();
    await itg.ticket(SEAT).reserve("alice");
    await itg.seatMap.set({ seatId: SEAT, status: "RESERVED" });

    t.assert.equal(await itg.ticket(SEAT).release("alice"), true, "本人釋放應回 true");
    t.assert.equal(await itg.seatMap.set({ seatId: SEAT, status: "AVAILABLE" }), true);

    const truth = itg.stateOf("Ticket", SEAT).data.state as TicketState;
    t.assert.equal(truth.status, "AVAILABLE");
    t.assert.equal(truth.reservedBy, null);
    t.assert.equal(viewOf(itg), "AVAILABLE", "view 與真值一致（可正常釋放）");
  });

  // 核心修復斷言（現行紅燈 → it.skip）：真值已由他人 RESERVED 時，
  // 過期的 AVAILABLE 回寫必須被條件寫入丟棄，view 維持與真值一致。
  it.skip("真值 RESERVED by 他人 → 丟棄過期的 AVAILABLE 回寫（幽靈可售席位消滅）", async (t) => {
    const itg = createIntegration();
    // A 的 saga 前半＋補償 release（#22 守衛放行：檢查當下仍由 alice 持有）
    await itg.ticket(SEAT).reserve("alice");
    await itg.seatMap.set({ seatId: SEAT, status: "RESERVED" });
    t.assert.equal(await itg.ticket(SEAT).release("alice"), true);

    // 交錯視窗內：B 合法接管並寫入自己的 view（分析報告 E3 次序）
    await itg.ticket(SEAT).reserve("bob");
    await itg.seatMap.set({ seatId: SEAT, status: "RESERVED" });

    // A 的過期回寫送達——條件寫入必須丟棄（WI-5：丟棄並由回寫呼叫端觀察 false）
    t.assert.equal(await itg.seatMap.set({ seatId: SEAT, status: "AVAILABLE" }), false);
    t.assert.equal(viewOf(itg), "RESERVED", "view 不得被寫成 AVAILABLE（必須與 bob 的真值一致）");

    const truth = itg.stateOf("Ticket", SEAT).data.state as TicketState;
    t.assert.equal(truth.status, "RESERVED");
    t.assert.equal(truth.reservedBy, "bob");

    // 外部可觀察結果：依視圖行動的第三人看到的是與真值一致的「不可下單」
    await t.assert.rejects(
      async () => await itg.ticket(SEAT).reserve("carol"),
      (err: Error) => err instanceof TerminalError && /currently reserved/.test(err.message)
    );
  });

  // 同機制的延伸邊界（現行紅燈 → it.skip）：真值 SOLD（已成交）同樣不得被
  // 過期的 AVAILABLE 覆蓋——補償路徑若因任何原因帶着過期判斷寫回，不得復活幽靈可售票。
  it.skip("真值 SOLD → 丟棄 AVAILABLE 回寫（已成交席位不得被覆蓋成可售）", async (t) => {
    const itg = createIntegration();
    await itg.ticket(SEAT).reserve("alice");
    await itg.seatMap.set({ seatId: SEAT, status: "RESERVED" });
    t.assert.equal(await itg.ticket(SEAT).release("alice"), true);

    // B 完整成交（真值 SOLD＋view SOLD）
    await itg.ticket(SEAT).reserve("bob");
    await itg.ticket(SEAT).confirm("bob");
    await itg.seatMap.set({ seatId: SEAT, status: "SOLD" });

    // A 的過期回寫送達
    t.assert.equal(await itg.seatMap.set({ seatId: SEAT, status: "AVAILABLE" }), false);
    t.assert.equal(viewOf(itg), "SOLD", "view 必須維持與真值一致（SOLD）");

    const truth = itg.stateOf("Ticket", SEAT).data.state as TicketState;
    t.assert.equal(truth.status, "SOLD");
    t.assert.equal(truth.reservedBy, "bob");
  });
});

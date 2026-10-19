// test/checkout_view_toctou.test.ts — Issue #80（AP3）：釘住 checkout 補償視圖回寫的 TOCTOU（R3）。
//
// 依據：docs/research/76-checkout-compensation-concurrency-analysis.md §3.3（E3）。
// Issue #22 的修復（src/checkout.ts:35–39：`release` 回 true 才回寫 SeatMap view）仍有
// check→write 競態：守衛在「檢查當下」評估（ticket.release 對仍由本人持有的票回 true），
// 視圖寫入卻發生在其後——SeatMap 與 Ticket 分屬兩個虛擬物件、兩次獨立呼叫，中間無原子性。
// 若 `release=true` 之後、A 的 `seatMap.set(AVAILABLE)` 送達之前，B 完成
// `reserve`＋寫入 `RESERVED`，A 的過期 AVAILABLE 回寫會覆蓋 B 的有效保留
// （SeatMap.set 為無條件 last-writer-wins，src/game.ts:132–135），
// 造成「view 顯示 AVAILABLE、真值是他人有效保留」的幽靈可售席位。
//
// 本檔以既有整合式 harness（test/helpers/integration.ts，真實 handler 接線）按
// checkout saga 在程式碼容許下的真實呼叫次序重現交錯（Issue #80 要求 1）：
// `reserve(alice) → set RESERVED → release(alice)=true → B 接管 → set AVAILABLE`。
//
// 交付判定（Issue #80 要求 3、任務規則）：實測確認現行實作**確實會踩到**——
// 「回寫不得覆蓋第三人」的斷言在既有實作上是紅燈（非測試自身錯誤），
// 故該條以 it.skip 交付、斷言完整保留（該層 CI 仍綠）；建議另開
// agent-fix-bug（分析報告 WI-5／§5.2 R3：SeatMap 條件寫入 expected-owner/status）。
// 【Issue #82（AP5）已修復】src/game.ts 的 SeatMap.set 對 AVAILABLE 降級寫入改為
// 條件寫入（同一次 handler 執行內讀 Ticket 真值，他人持有即丟棄回寫）。本檔的
// 應然斷言已 un-skip 轉綠；characterization 依 Issue #82 指示更新為「修復後行為」
// （view 與真值一致）——交錯次序本身不變，變的是過期回寫不再能覆蓋第三人。
// 另附 characterization 測試釘住**現行行為**（綠燈）：#82 前為「交錯後 view≠truth、
// 第三人依視圖下單被真值擋下」；修復後依 Issue #82 指示更新為「過期回寫被丟棄、
// view 與真值一致」——这正是 characterization 的價值（修復造成可觀察差異，防止靜默回退）。
//
// 範圍：只新增 test/ 下測試，不動 src/。
import { describe, it } from "node:test";
import { createIntegration, TerminalError } from "./helpers/integration";
import type { TicketState } from "../src/game";

const SEAT = "seat-9";

/**
 * Issue #80 要求 1 的交錯次序，逐步對應 src/checkout.ts 的真實呼叫：
 *   A: reserve(16 行) → seatMap.set RESERVED(18 行) → 付款失敗 → release(35 行)=true
 *   B: （視窗內）接管同一座位 reserve → seatMap.set RESERVED（B 的 step1）
 *   A: seatMap.set AVAILABLE(38 行)——依「檢查當下」的過期判斷延遲回寫
 */
async function runR3Interleaving(itg: ReturnType<typeof createIntegration>) {
  // A 的 saga 前半（step1 + view 寫入）
  await itg.ticket(SEAT).reserve("alice");
  await itg.seatMap.set({ seatId: SEAT, status: "RESERVED" });

  // A 的補償前半：付款失敗走 catch，release("alice") 在檢查當下仍由本人持有 → true
  const released = await itg.ticket(SEAT).release("alice");

  // 交錯：release=true 之後、A 回寫 view 之前，B 合法接管（A 已釋放，座位真值 AVAILABLE）
  await itg.ticket(SEAT).reserve("bob");
  await itg.seatMap.set({ seatId: SEAT, status: "RESERVED" });

  // A 的補償後半：if (released) 分支的延遲回寫（checkout.ts:36–39）
  await itg.seatMap.set({ seatId: SEAT, status: "AVAILABLE" });

  return released;
}

describe("Issue #80 R3——補償視圖回寫 TOCTOU（#22 修復殘留窗口）", () => {
  // characterization：釘住「現行行為」（綠燈）。Issue #82 修復後依該 Issue 指示更新為
  // 「修復後行為」：交錯仍如序發生，但 A 的過期 AVAILABLE 回寫被條件寫入丟棄——
  // 修復造成可觀察差異（view 不再≠truth），這正是 characterization 的價值。
  it("交錯重現（characterization，#82 修復後）：release=true → B 接管 → A 的過期回寫被條件寫入丟棄", async (t) => {
    const itg = createIntegration();
    const released = await runR3Interleaving(itg);

    // 守衛在檢查當下確實放行——這正是 #22 修復無法覆蓋的部分
    t.assert.equal(released, true, "release 在檢查當下應回 true（alice 仍持有）");

    // 真值：bob 的有效保留未被 A 的 release 觸碰（release 發生於接管前、守衛保護真值）
    const truth = itg.stateOf("Ticket", SEAT).data.state as TicketState;
    t.assert.equal(truth.status, "RESERVED");
    t.assert.equal(truth.reservedBy, "bob");

    // 修復後行為（原釘選缺陷「A 的過期回寫覆蓋 B 的 view」已被條件寫入消滅）：
    const map = itg.stateOf("SeatMap", "global").data.map as Record<string, string>;
    t.assert.equal(
      map[SEAT],
      "RESERVED",
      "修復後：條件寫入丟棄 A 的過期 AVAILABLE 回寫，view 維持與真值一致（RESERVED by bob）"
    );

    // 真值守衛照常生效：carol 搶下單被 RESERVED 真值擋下（此時 view 同為 RESERVED，
    // 前端依視圖本就不會開放下單——幽靈可售席位消滅）
    await t.assert.rejects(
      async () => await itg.ticket(SEAT).reserve("carol"),
      (err: Error) => err instanceof TerminalError && /currently reserved/.test(err.message),
      "第三人依視圖行動不會再被「可售假象」誤導"
    );

    // 損害範圍限定於視圖（分析報告 §1 優先序 R3=P2 的依據）：真值仍屬 bob
    const after = itg.stateOf("Ticket", SEAT).data.state as TicketState;
    t.assert.equal(after.status, "RESERVED");
    t.assert.equal(after.reservedBy, "bob");
  });

  // 要求 2 的「應然」斷言：A 的回寫不得把已由 B 持有的座位寫成 AVAILABLE。
  // Issue #80 交付時在既有實作（seatMap.set 無條件覆蓋）上為紅燈，依任務規則以
  // it.skip 保留完整斷言；Issue #82（WI-5：SeatMap 條件寫入）已修復——本層 un-skip，
  // 沙箱實測「先紅（修復前）後綠（修復後）」，證據見 PR 描述與 Issue #82 留言。
  it("應然語意（#82 已修復）：A 的回寫不得把已由 B 持有的座位寫成 AVAILABLE", async (t) => {
    const itg = createIntegration();
    const released = await runR3Interleaving(itg);

    t.assert.equal(released, true, "release 在檢查當下應回 true");

    // 真值不受影響（#22 守衛已保證的部分）
    const truth = itg.stateOf("Ticket", SEAT).data.state as TicketState;
    t.assert.equal(truth.status, "RESERVED");
    t.assert.equal(truth.reservedBy, "bob");

    // 核心斷言（Issue #80 要求 2）：延遲回寫不得覆蓋第三人持有的座位
    const map = itg.stateOf("SeatMap", "global").data.map as Record<string, string>;
    t.assert.notEqual(
      map[SEAT],
      "AVAILABLE",
      "A 的過期 AVAILABLE 回寫不得把已由 B 持有的座位寫成可售"
    );
    // 修復後視圖應與真值收斂一致（B 的 step1 寫入仍是最後的有效值）
    t.assert.equal(map[SEAT], "RESERVED", "view 應恆等於/最終收斂於真值（RESERVED by bob）");

    // 收斂一致後，carol 依視圖下單被拒是「正確的誤會已不存在」的對照：
    // view=RESERVED 時前端本就不該呈現可下單位（幽靈可售席位消滅）
    t.assert.equal(map[SEAT] !== "AVAILABLE", true, "不再存在「視圖可售、真值不可售」的席位");
  });
});

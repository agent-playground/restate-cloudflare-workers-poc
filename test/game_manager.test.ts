// src/game_manager.ts — GameManager.reset 批次釋放行為單元測試。
import { describe, it } from "node:test";
import { gameManager } from "../src/game_manager";
import { createMockContext, createMockState, handlersOf } from "./helpers/mocks";

const handlers = () =>
  handlersOf<{ reset: (ctx: any) => Promise<unknown> }>(gameManager, "service");

describe("GameManager.reset()", () => {
  it("對 seat-1..seat-50 逐張發出 fire-and-forget release（視圖由 SeatMap.set 於觸發時就地重置）", async (t) => {
    const mock = createMockState();
    const ctx = createMockContext(mock);
    t.assert.equal(await handlers().reset(ctx), undefined);

    // 共 50 個 fire-and-forget Ticket.release；不再無條件重設視圖——SeatMap.set 觸發重置時
    // 已就地重置並保留 SOLD，GameManager 若再無條件寫回 AVAILABLE 會覆蓋已售出座位。
    t.assert.equal(mock.sendCalls.length, 50);
    const releases = mock.sendCalls
      .filter((c) => c.service === "Ticket")
      .map((c) => `${c.key}.${c.handler}`);
    const expected = Array.from({ length: 50 }, (_, i) => `seat-${i + 1}.release`);
    t.assert.deepStrictEqual(releases, expected);
  });
});

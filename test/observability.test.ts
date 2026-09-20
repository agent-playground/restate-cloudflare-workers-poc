// src/ 與 src/index.ts — invocation id 關聯測試。
//
// 動機：Restate 框架日誌以 [restate][…][component/handler][inv_…] 標記每次 invocation；
// 本 PR 讓應用事件（handler 內）與邊緣全寬事件都帶上同一個 invocationId，
// 事故時可用單一 id 從入口請求串連到各步驟，不必跨兩個日誌來源肉眼比對。
// 這裡攔截 console 輸出，逐行解析 JSON 事件並斷言該欄位存在且一致。
import { describe, it } from "node:test";
import worker from "../src/index";
import { ticketObject } from "../src/game";
import { checkoutWorkflow } from "../src/checkout";
import { createMockContext, createMockState, handlersOf } from "./helpers/mocks";

type Event = Record<string, unknown>;

/** 攔截 console.log/error，解析本專案 logger 發出的單行 JSON 事件。 */
async function captureEvents<T>(fn: () => Promise<T>): Promise<{ result: T; events: Event[] }> {
  const events: Event[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const record = (first: unknown) => {
    if (typeof first !== "string") return;
    try {
      events.push(JSON.parse(first) as Event);
    } catch {
      // 非本專案 logger 的輸出，忽略。
    }
  };
  (console as unknown as { log: unknown }).log = record;
  (console as unknown as { error: unknown }).error = record;
  try {
    return { result: await fn(), events };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function findEvent(events: Event[], msg: string): Event | undefined {
  return events.find((e) => e.msg === msg);
}

describe("invocation id 關聯", () => {
  it("Ticket.reserve 拒絕事件帶上 ctx.request().id", async (t) => {
    const mock = createMockState({
      state: { status: "SOLD", reservedBy: "bob", reservedUntil: null },
    });
    const ctx = createMockContext(mock);
    const handlers = handlersOf<Record<string, (ctx: any, arg?: unknown) => Promise<unknown>>>(
      ticketObject,
      "object"
    );

    const { events } = await captureEvents(async () => {
      await t.assert.rejects(() => handlers.reserve(ctx, "alice"));
    });

    t.assert.equal(findEvent(events, "ticket reservation rejected")?.invocationId, "inv_test");
  });

  it("Checkout.process 開始與完成事件帶上 ctx.request().id", async (t) => {
    const mock = createMockState();
    const ctx = createMockContext(mock);
    const handlers = handlersOf<{
      process: (ctx: any, request: { ticketId: string; userId: string }) => Promise<string>;
    }>(checkoutWorkflow, "service");

    const { events } = await captureEvents(() =>
      handlers.process(ctx, { ticketId: "seat-7", userId: "alice" })
    );

    t.assert.equal(findEvent(events, "checkout started")?.invocationId, "inv_test");
    t.assert.equal(findEvent(events, "checkout completed")?.invocationId, "inv_test");
  });

  it("邊緣事件沿用 x-restate-invocation-id，與 handler 事件同一 id", async (t) => {
    const invocationId = "inv_0123456789abcdef";
    const { result, events } = await captureEvents(() =>
      worker.fetch(
        new Request("https://nexus-poc.test.example/Checkout/process", {
          method: "POST",
          headers: { "x-restate-invocation-id": invocationId },
        }),
        {},
        {}
      )
    );

    t.assert.equal(result.status, 599); // stub 標記：請求已交給 restate endpoint
    t.assert.equal(findEvent(events, "worker request completed")?.invocationId, invocationId);
  });
});

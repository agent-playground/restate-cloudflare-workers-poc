import { createEndpointHandler } from "@restatedev/restate-sdk-cloudflare-workers/fetch";
import { ticketObject, seatMapObject } from "./game";
import { checkoutWorkflow } from "./checkout";
import { gameManager } from "./game_manager";
import { delay } from "./utils/delay";
import { logger, errorFields, LogFields } from "./utils/logger";

logger.info("worker started", { service: "nexus-poc" });

const restateHandler = createEndpointHandler({
    services: [ticketObject, checkoutWorkflow, seatMapObject, gameManager],
});

async function handleMockPayment(request: Request, event: LogFields): Promise<Response> {
    if (request.method !== "POST") {
        event.outcome = "method_not_allowed";
        return new Response("Method not allowed", { status: 405 });
    }

    const body = await request.json() as { amount: number; paymentMethodId: string };
    // 業務欄位進全寬事件（不再另發一行），讓單一請求事件即可回答
    // 「哪個金額／付款方式、結果為何、耗時多少」。
    event.amount = body.amount;
    event.paymentMethodId = body.paymentMethodId;

    // Simulate processing time（測試可經 setDelayImpl 歸零）
    await delay(500);

    if (body.paymentMethodId === "card_decline") {
        event.outcome = "declined";
        return new Response(JSON.stringify({ error: "Insufficient funds" }), {
            status: 402,
            headers: { "Content-Type": "application/json" }
        });
    }

    if (body.paymentMethodId === "card_error") {
        event.outcome = "gateway_timeout";
        return new Response(JSON.stringify({ error: "Gateway timeout" }), {
            status: 503,
            headers: { "Content-Type": "application/json" }
        });
    }

    const transactionId = crypto.randomUUID();
    event.outcome = "charged";
    event.transactionId = transactionId;
    return new Response(JSON.stringify({ success: true, transactionId }), {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Version": "v2" }
    });
}

export default {
    fetch: async (request: Request, env: any, ctx: any) => {
        const startedAt = Date.now();
        const url = new URL(request.url);
        const isMockPayment = url.pathname === "/api/mock-payment";

        // 邊緣全寬事件：每個請求恰好一行，含路由、結果狀態與耗時。
        // 在此之前，被丟出的例外（例如 POST 非 JSON body）在應用層完全無跡可循——
        // runtime 只回 500，這裡讓它在 Workers Logs 留下可查詢的一行。
        const event: LogFields = {
            method: request.method,
            path: url.pathname,
            route: isMockPayment ? "mock-payment" : "restate",
        };

        try {
            const response = isMockPayment
                ? await handleMockPayment(request, event)
                : await restateHandler(request, env, ctx);
            event.status = response.status;
            event.durationMs = Date.now() - startedAt;
            // 5xx（例如模擬閘道逾時）以 error 等級呈現，其餘為 info。
            if (response.status >= 500) {
                logger.error("worker request completed", event);
            } else {
                logger.info("worker request completed", event);
            }
            return response;
        } catch (error) {
            event.durationMs = Date.now() - startedAt;
            logger.error("worker request failed", { ...event, ...errorFields(error) });
            throw error;
        }
    },
};

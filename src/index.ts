import { createEndpointHandler } from "@restatedev/restate-sdk-cloudflare-workers/fetch";
import { ticketObject, seatMapObject } from "./game";
import { checkoutWorkflow } from "./checkout";
import { gameManager } from "./game_manager";
import { delay } from "./utils/delay";
import { logger, errorFields } from "./utils/logger";

console.log("Starting worker script with createEndpointHandler...");

const SERVICE_NAME = "nexus-poc";

const restateHandler = createEndpointHandler({
    services: [ticketObject, checkoutWorkflow, seatMapObject, gameManager],
});

async function handleMockPayment(request: Request): Promise<Response> {
    if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
    }

    const body = await request.json() as { amount: number; paymentMethodId: string };
    logger.info("mock payment gateway received request", {
        amount: body.amount,
        paymentMethodId: body.paymentMethodId,
    });

    // Simulate processing time（測試可經 setDelayImpl 歸零）
    await delay(500);

    if (body.paymentMethodId === "card_decline") {
        return new Response(JSON.stringify({ error: "Insufficient funds" }), {
            status: 402,
            headers: { "Content-Type": "application/json" }
        });
    }

    if (body.paymentMethodId === "card_error") {
        return new Response(JSON.stringify({ error: "Gateway timeout" }), {
            status: 503,
            headers: { "Content-Type": "application/json" }
        });
    }

    return new Response(JSON.stringify({ success: true, transactionId: crypto.randomUUID() }), {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Version": "v2" }
    });
}

export default {
    fetch: async (request: Request, env: any, ctx: any) => {
        const startedAt = Date.now();
        const url = new URL(request.url);
        const route = url.pathname === "/api/mock-payment" ? "mock-payment" : "restate-endpoint";
        let status = 500;

        try {
            const response = url.pathname === "/api/mock-payment"
                ? await handleMockPayment(request)
                : await restateHandler(request, env, ctx);
            status = response.status;
            return response;
        } catch (error) {
            logger.error("request failed", {
                service: SERVICE_NAME,
                route,
                method: request.method,
                path: url.pathname,
                ...errorFields(error),
            });
            throw error;
        } finally {
            logger.info("request handled", {
                service: SERVICE_NAME,
                route,
                method: request.method,
                path: url.pathname,
                status,
                durationMs: Date.now() - startedAt,
            });
        }
    },
};

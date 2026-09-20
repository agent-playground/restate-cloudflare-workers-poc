import { delay } from "./delay";
import { logger } from "./logger";

export async function processPayment(amount: number, paymentMethodId: string): Promise<boolean> {
    // 每次呼叫一個結果事件，帶上 amount / paymentMethodId / outcome：
    // 事故時可查「哪個金額、哪種付款方式失敗」，不再只有一句無上下文的 console.log。
    await delay(500); // Simulate 500ms latency（測試可經 setDelayImpl 歸零）

    if (paymentMethodId === "card_decline") {
        logger.info("payment declined", { amount, paymentMethodId, outcome: "declined" });
        throw new Error(`Payment declined (Method: ${paymentMethodId})`);
    }

    if (paymentMethodId === "card_error") {
        logger.error("payment gateway timeout", { amount, paymentMethodId, outcome: "gateway_timeout" });
        throw new Error("Gateway timeout");
    }

    logger.info("payment succeeded", { amount, paymentMethodId, outcome: "succeeded" });
    return true;
}

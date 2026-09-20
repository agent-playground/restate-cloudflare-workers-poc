import * as restate from "@restatedev/restate-sdk-cloudflare-workers/fetch";
import { ticketObject, seatMapObject, TicketObject } from "./game";
import { processPayment } from "./utils/payment_new";
import { sendEmail } from "./utils/email";
import { logger, errorFields } from "./utils/logger";

export const checkoutWorkflow = restate.service({
    name: "Checkout",
    handlers: {
        process: async (ctx: restate.Context, request: { ticketId: string; userId: string; paymentMethodId?: string }) => {
            const { ticketId, userId, paymentMethodId = "card_success" } = request;
            logger.info("checkout started", { ticketId, userId, paymentMethodId });
            const ticket = ctx.objectClient<TicketObject>(ticketObject, ticketId);
            const seatMap = ctx.objectClient(seatMapObject, "global");

            // Step 1: Reserve Ticket
            // 注意：reserve 失敗（他人已 SOLD／保留）會在 try 之外直接拋出，過去完全沒有應用層日誌；
            // 該拒絕路徑現由 Ticket.reserve 自身記錄（見 game.ts）。
            await ticket.reserve(userId);
            // Update SeatMap (View)
            await seatMap.set({ seatId: ticketId, status: "RESERVED" });

            try {
                // Step 2: Process Payment
                await ctx.run("process-payment", async () => {
                    try {
                        return await processPayment(100, paymentMethodId);
                    } catch (e) {
                        throw new restate.TerminalError(`Payment declined: ${(e as Error).message}`);
                    }
                });
            } catch (error) {
                // Step 3: Compensation
                // Issue #22：release 對「已 SOLD（或已由他人保留）」的票會回 false——
                // 此時本 saga 已不再持有該座位，若仍無條件把 view 寫回 AVAILABLE，
                // 會覆蓋買家較新的 SOLD 寫入（last-writer-wins）而產生永久性「幽靈可售票」。
                // 因此僅在確實釋放成功時才回寫視圖。
                const released = await ticket.release(userId);
                if (released) {
                    // Revert SeatMap (View)
                    await seatMap.set({ seatId: ticketId, status: "AVAILABLE" });
                }
                // 補償結果是 Saga 最關鍵、也最難事後重建的一步：released=false 代表本流程已不持有
                // 該座位、視圖因此不回寫。過去此分支一出事就只能從「視圖為何是 AVAILABLE」反推；
                // 現在可直接查 released 與原始錯誤，一眼定位是補償未回寫還是補償本身失敗。
                logger.error("checkout payment failed; reservation compensated", {
                    ticketId,
                    userId,
                    paymentMethodId,
                    released,
                    ...errorFields(error),
                });
                throw new restate.TerminalError(`Payment failed: ${(error as Error).message}`);
            }

            // Step 4: Confirm Ticket
            await ticket.confirm(userId);
            // Update SeatMap (View)
            await seatMap.set({ seatId: ticketId, status: "SOLD" });

            // Step 5: Send Email
            await ctx.run("send-email", async () => {
                await sendEmail(userId, "Booking Confirmed", `You have successfully purchased ticket ${ticketId}.`);
            });

            // 成功結帳過去沒有任何完成事件，無法回答「這筆票到底成交了沒、賣給誰」。
            logger.info("checkout completed", { ticketId, userId, paymentMethodId, status: "SOLD" });
            return "Booking Confirmed";
        },
    },
});

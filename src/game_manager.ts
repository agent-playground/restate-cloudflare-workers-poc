import * as restate from "@restatedev/restate-sdk-cloudflare-workers/fetch";
import { ticketObject } from "./game";
import { logger } from "./utils/logger";

export const gameManager = restate.service({
    name: "GameManager",
    handlers: {
        reset: async (ctx: restate.Context) => {
            const invocationId = ctx.request().id;
            logger.info("game manager reset started", { invocationId, seats: 50 });

            // 視圖 (SeatMap) 已由觸發此重置的 SeatMap.set 就地重置，且該處會保留 SOLD 座位
            // （幽靈可售票防護，見 load-test.js I2）。此處不再重設視圖：過去無條件把
            // seat-1..50 全寫回 AVAILABLE，會覆蓋已售出的座位、使已付款的票重新可售。
            // GameManager 只負責逐一釋放「未售出」的票（Ticket.release 對 SOLD 會拒絕）。
            for (let i = 1; i <= 50; i++) {
                ctx.objectSendClient(ticketObject, `seat-${i}`).release();
            }
        }
    }
});

export type GameManager = typeof gameManager;

// 結構化日誌（零新增相依）。
//
// 為什麼需要：wrangler.toml 已啟用 Workers Observability（logs + traces, head_sampling_rate=1），
// 但 src 目前所有輸出都是字串內插的 console.log（例如
// `Checkout process started for ticket: ${ticketId}, user: ${userId}`）。這類事件在 Workers Logs
// 裡只是一個不可解析的字串：無法用 ticketId / userId / status / durationMs 等欄位查詢、篩選或分群，
// 事故當下只能逐行肉眼掃描。
//
// 這裡把 console 包成單一 JSON 事件（一行一事件），欄位可被 Workers Logs 直接查詢：
//   { level, msg, time, ...fields }
// 訊息一律為固定字串模板，動態值全部放進 fields——避免事件模板被內插切碎而無法分群
// （見 logging 規範：observability 工具以 message template 聚類事件）。
//
// 等級刻意只有兩個：info（正常操作與業務事件）與 error（需要關注的非預期失敗）。
// console.error 讓 Workers Logs 依方法判定為 error 等級。

export type LogFields = Record<string, unknown>;

/** 把 Error 轉成可序列化的欄位（JSON.stringify(new Error(...)) 只會得到 {}）。 */
export function errorFields(error: unknown): LogFields {
    if (error instanceof Error) {
        return { errorName: error.name, errorMessage: error.message };
    }
    return { errorName: "NonError", errorMessage: String(error) };
}

function emit(level: "info" | "error", msg: string, fields: LogFields): void {
    const line = JSON.stringify({ level, msg, time: new Date().toISOString(), ...fields });
    if (level === "error") {
        console.error(line);
    } else {
        console.log(line);
    }
}

export const logger = {
    /** 正常操作與業務事件（每個請求恰好一行）。 */
    info: (msg: string, fields: LogFields = {}): void => emit("info", msg, fields),
    /** 非預期失敗；呼叫端應帶上 errorFields(error) 以保留錯誤名稱與訊息。 */
    error: (msg: string, fields: LogFields = {}): void => emit("error", msg, fields),
};

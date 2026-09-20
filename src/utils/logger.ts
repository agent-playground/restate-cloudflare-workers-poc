// 結構化事件日誌（零新增相依）。
//
// 為什麼需要：目前每個 log 站都以樣板字串輸出（console.log(`...${value}`)），
// 動態值全被併進 message，在 Workers Logs 只能做全文比對。wrangler.toml 已開啟
// [observability] logs，而 Workers Logs 會索引「以物件輸出」事件的頂層欄位；
// 因此本模組把每個事件以單一物件輸出：固定的事件名（message）＋一組可查詢欄位。
// 一次請求／一次狀態轉移只輸出一筆事件。
//
// 等級只有兩個：info（正常流程，含每個請求的 wide event）與 error（需要人介入的失敗）。
// message 一律為常數字串，動態值只放欄位——避免同一事件因動態值而被切成多個模板。

export type LogFields = Record<string, unknown>;

export const logger = {
    /** 正常流程事件（含每個請求完成時的 wide event）。 */
    info(message: string, fields: LogFields = {}): void {
        console.log({ message, ...fields });
    },
    /** 需要人介入的失敗事件。 */
    error(message: string, fields: LogFields = {}): void {
        console.error({ message, ...fields });
    },
};

/** 把 catch 到的未知拋出值轉成可查詢欄位，保留除錯所需的 name／message／stack。 */
export function errorFields(error: unknown): LogFields {
    if (error instanceof Error) {
        return { error: error.message, errorName: error.name, stack: error.stack };
    }
    return { error: String(error) };
}

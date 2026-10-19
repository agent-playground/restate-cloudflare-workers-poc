# AP1：checkout 補償與併發風險分析（Issue #76）

> 任務類型：agent-analyze（docs/06 §4：僅產出分析與方案，不得實作）。
> 本報告**不具放行效力**，供人類審查後據以開立後續工作項。
> 目標模組：`src/checkout.ts`、`src/game.ts`、`src/utils/payment_new.ts`（附帶 `src/game_manager.ts`、`src/index.ts`）。
> 基線：分支 `software-factory`（merge `df632de`）。驗證命令實測：`npm run build:tests` 退出碼 0；`npm test` 64 通過／0 失敗（全綠，未跳過）。
> 撰寫日期：2026-10-19。

---

## 1. 結論摘要

1. **補償路徑的涵蓋範圍只有「付款」一步。** `checkout.ts` 的 `try/catch`（`src/checkout.ts:20–41`）只包住 `process-payment`；其後的 `ticket.confirm`（第 44 行）與 `SeatMap` SOLD 回寫（第 46 行）都在補償範圍之外。**已扣款後任何一步失敗，系統不做釋放、不做退款、不回寫視圖**——而整個 codebase 沒有任何退款操作（`src/utils/payment_new.ts` 只有扣款方向；全 repo `refund/退款` 出現次數為 0）。實測重現（E2）：付款成功 → 併發者於 TTL 逾期視窗搶走座位 → confirm 拋 `TerminalError`、release 呼叫 0 次、錢已扣票沒了、不發信。此為**資金流失級風險**。

2. **回合自動重置（auto-reset）會抹掉已成交（SOLD）票券的真值，且同一座位可被再次完整售出。** `SeatMap.set` 湊滿 50 SOLD 即 fire-and-forget `GameManager.reset`（`src/game.ts:138–151`），後者對 seat-1..50 發出**無身分的 `release()`**（`src/game_manager.ts:15–17`），而 `Ticket.release` 的守衛只在 `userId !== undefined` 時才檢查（`src/game.ts:92–99`）——已付款票券被直接清回 `AVAILABLE`。實測重現（E1）：對 seat-1 分別有 `user-1` 與 `mallory` 兩次「扣款＋confirm＋發信」全部成功，**同一座位雙重銷售，第一位買家無任何補償**。既有測試只釘住 handler 層「無參數 release 會釋放 SOLD」（`test/game.test.ts:182–188`，characterization）與序列化鏈條（S6，`test/integration_scenarios.test.ts:252–290`），**未釘住「重置後轉售＝雙重銷售＋未退款」的業務後果**，也未釘住重置與 in-flight saga 的交錯。

3. **Issue #22 的修復（release 回 true 才回寫視圖）殘留 TOCTOU：** 守衛在「檢查當下」評估，視圖寫入發生在其後（`src/checkout.ts:35–39`），中間是兩次獨立虛擬物件呼叫的網路間隙。實測重現（E3）：`release=true → B 接管並寫 RESERVED → A 的 AVAILABLE 延遲回寫覆蓋` → 視圖顯示 `AVAILABLE` 而真值是他人有效保留（幽靈可售席位；第三人依視圖下單會收到 `currently reserved` 錯誤）。

4. **推論級（本次沙箱無法實測、需生產 Restate E2E 驗證）兩項：** `processPayment` 無冪等鍵而 `ctx.run` 是 at-least-once（崩潰重放＝可能重複扣款，`src/utils/payment_new.ts:3–21`、`src/index.ts:14–31` 模擬閘道亦不去重）；以及 Issue #21「同 user 重複 reserve 一律拒絕」在 reserve 回覆遺失重放的假設下會造成「使用者被自己的幽靈保留鎖住 15 分鐘」的可用性問題（`src/game.ts:42–44`，測試註解 `test/game.test.ts:41–44` 宣稱依賴 journal 重放保證——該保證在 harness 中無法驗證）。

**優先序**：R2（付款後無補償）與 R1（重置雙重銷售）為 P0——兩者都是「使用者已被扣款而系統無補償路徑」的資金類缺陷，且 R1 的觸發條件（湊滿 50）可決定性重現、R2 的交錯視窗在生產（付款重試、worker 暫停、TTL 15 分鐘遠大於正常流程）反而更寬。R3 為 P2（真值仍受守衛保護，損害限於視圖一致性與 UI 誤導）。R4/R5 為待驗證的 P1/P2。

---

## 2. 現行補償路徑與併發控制（Issue 要求 1）

### 2.1 Checkout saga 的實際步驟（`src/checkout.ts:9–54`）

| 步驟 | 行號 | 效果 | 失敗時有無補償 |
|---|---|---|---|
| 1a `ticket.reserve(userId)` | 16 | Ticket 真值 AVAILABLE→RESERVED，TTL 15 分鐘（`src/game.ts:50`） | 在 `try` **之外**；reserve 本身拋錯→不付款不補償（正確，未持有）；**但 reserve 成功後的任何非付款步驟拋錯都不在補償範圍** |
| 1b `seatMap.set(RESERVED)` | 18 | 視圖寫入 | 在 `try` 之外，無補償 |
| 2 `ctx.run("process-payment")` | 22–28 | 扣款（模擬 500ms，`payment_new.ts:7`；`card_decline`/`card_error` 拋錯） | **唯一被 catch 覆蓋的步驟** |
| 3 補償：`ticket.release(userId)` → 回 true 才 `seatMap.set(AVAILABLE)` | 29–41（35、36–39） | 釋放保留＋視圖回寫 | #22 修復：票已 SOLD 或由他人持有→`release` 回 false→不回寫視圖 |
| 4 `ticket.confirm(userId)` → `seatMap.set(SOLD)` | 44、46 | 真值 RESERVED→SOLD；視圖 SOLD | **無任何補償**（在 `try` 之外） |
| 5 `ctx.run("send-email")` | 49–51 | 發信 | 失敗只重試、不影響票券（可接受） |

補償語意注意：即使走到第 3 步，「補償」＝釋放保留＋視圖回寫，**不含退款**。目前這在語意上自洽（第 3 步只在付款失敗時觸發），但這正是 R2 的根源——付款**成功**之後的失敗（第 4/4b 步）没有任何對稱的補償設計。

### 2.2 併發控制

- **Ticket／SeatMap 為 per-key 虛擬物件**（`src/game.ts:16,129`；SeatMap 為單一分區 `"global"`）。同一 key 的 handler 執行序列化（Restate exclusive 語意；測試 harness 以 per-`(service,key)` FIFO 互斥逼近，見 `test/helpers/integration.ts` 開頭「Issue #20 保真度升級 ①」）。
- **Ticket 狀態機守衛**：`reserve` 拒 SOLD（`game.ts:26–28`）、拒一切有效 RESERVED 含同 user（#21，`game.ts:38–44`）、TTL 逾期自動釋放後可接手（`game.ts:31–36`）；`confirm` 認領守衛（`game.ts:72–75`）＋已 SOLD 同主冪等／異主拒絕（`game.ts:64–70`）；`release(userId)` 僅持身分呼叫時受守衛（`game.ts:91–99`），**無參數呼叫完全無守衛**。
- **SeatMap 是去正規化視圖**：`set` 為無條件 last-writer-wins 覆寫（`game.ts:132–135`），不檢查擁有者或期望前值；它與 Ticket 真值的同步由 **checkout saga 在两次獨立的物件呼叫之間**手工維持——這正是 #22/E3 竞態窗口（§3.3）的結構成因。
- **跨 saga 交錯點**：saga 中每個 `await`（reserve 回傳後、付款 run 邊界、confirm 前）都是其他 invocation 可插入真值的視窗；TTL 把「付款卡滯」變成「座位可被合法搶走」的時鐘。

---

## 3. 證據與根因（風險清單）

實測方式：以下 E1–E3 以 repo 既有整合式 harness（`test/helpers/integration.ts`，真實 handler 接線＋受控時鐘＋`ctx.run` hook 插隊）驅動，腳本與完整輸出見附錄 A；每次執行皆 `RESULT: ALL-REPRO-CONFIRMED`（13/13 檢查）。**標註【實測】＝本次沙箱內以真實 handler 重現；【推論】＝由碼路與執行期語意推斷、沙箱無法執行該執行期機制（持久化／重播／多機並行，見 `integration.ts:24–29` 自我限制的說明）。**

### 3.1 R1【實測 E1】auto-reset 抹除已成交真值 → 同一座位雙重銷售、首位買家無退款

- **觸發條件**：任何使 SeatMap `soldCount >= 50` 的寫入（`game.ts:138–139`）→ `GameManager.reset` fire-and-forget（`game.ts:150`；`game_manager.ts:11–17`）→ 50 張票**無身分 `release()`** → 守衛跳過（`game.ts:92`）→ SOLD 票回 `AVAILABLE`。
- **交錯時序（E1）**：50 席全部走完完整 checkout（各自扣款＋confirm＋發信成功）→ auto-reset 投遞 → seat-1 真值 AVAILABLE → mallory 再次完整結帳 seat-1 成功。實測斷言：`Ticket:seat-1` 的 `confirm` 真實 handler 對 `user-1` 與 `mallory` 各成功一次；全程 `process-payment` 51 次、`send-email` 51 次；`user-1` 的扣款**沒有任何退款或失效通知路徑**。
- **根因**：`release()` 的「無參數＝系統重置」特例（`game.ts:92–99` 只在 `userId !== undefined` 時檢查）與 `Ticket` 的 SOLD 終態語意（已收款交易）矛盾：重置把收款完成的交易無聲消滅。既有測試只把 handler 行為 characterization 化（`game.test.ts:182–188`）、S6 只釘序列化「全部釋放」的現況（`integration_scenarios.test.ts:252–290`），**未有任何測試宣告「重置後轉售同一席＝缺陷」**。另注：`integration_scenarios.test.ts:5` 的 S1–S6 清單中 **S5 從未出現**（全 repo 無 S5），Issue #17 的情境表可能有一條被漏交付。
- **生產相關性**：`load-test.js` 會持續購買（回合制是刻意設計），湊滿 50 是常態事件；重置與 in-flight checkout 的交錯（付款中票被 reset 釋放 → confirm 失敗）即 E2 的變體，視窗真實存在。

### 3.2 R2【實測 E2】付款成功後 confirm 失敗：零補償（不釋放、無退款、錢票兩空）

- **觸發條件**：saga 在 `process-payment` 完成後、`ticket.confirm` 前停頓（生產路徑：付款閘道重試、Worker 暫停／冷啟動、Restate invocation 重試、甚至 500ms 模擬延遲與慢環境），且停頓跨過 15 分鐘 TTL（`game.ts:50`）；其間任何第三人 `reserve`（逾期自動釋放，`game.ts:31–36`）＋`confirm` 成功。
- **交錯時序（E2）**：以受控時鐘＋`ctx.run` after hook 在「alice 付款完成、confirm 之前」把時鐘推進 16 分鐘並讓 bob 完整結帳同座位。實測斷言：alice 的 `process-payment` 已以 `card_success` 完成（**錢已扣**）；`Ticket:seat-7` 上 `release` 呼叫 **0 次**（補償完全未觸發）；alice 的結帳以 `TerminalError("Ticket already sold to another user: bob")` 終端失敗；不發信；真值 SOLD 給 bob。**alice 的 100 元滯留，無退款、無補償、無告警事件。**
- **根因**：補償 `try` 區塊只包付款（`checkout.ts:20–41`），confirm 與 SOLD 回寫（第 44、46 行）在範圍外；且系統根本沒有退款操作可用（§1 第 1 點）。既有覆蓋：S3（`integration_scenarios.test.ts:143–172`）以 `cleanup` 插隊同形狀釘住了「原樣外拋＋視圖殘留」的 characterization，但**未斷言「付款已完成＋零 release＝資金滯留」**；`race_counterexample.test.ts:79–121` 用 stub 的 confirm 拋錯、只斷言 reject＋不發信，其 `release` override 從未被呼叫也無人斷言。**「已扣款」後果在任何測試中都不曾被釘住。**
- **影響方向**：S3 的註解（`integration_scenarios.test.ts:137–142`）承認這是既有缺陷、留待 agent-fix-bug——本報告把缺陷的**資金語意與 TTL 觸發路徑**補全，使其可被寫成驗收條件。

### 3.3 R3【實測 E3（交錯次序）／窗口寬度推論】#22 修復殘留 TOCTOU：補償視圖回寫覆蓋第三人

- **觸發條件**：付款失敗走補償；`release(userId)` 檢查當下成功（回 true），但**在下一個獨立呼叫 `seatMap.set(AVAILABLE)` 送達前**，第三人完成 `reserve`＋寫入 `RESERVED`。#22 的守衛（`checkout.ts:35–39`）只防「釋放時已非本人持有」，無法防「釋放成功之後、回寫之前」被接手——檢查與寫入分屬兩個虛擬物件（Ticket 與 SeatMap）、兩次網路往返，中間無原子性。
- **交錯時序（E3）**：以程式碼容許的真實 handler 次序重現：`reserve(alice) → set RESERVED → release(alice)=true → reserve(bob) → set RESERVED → set AVAILABLE`。實測斷言：真值 `RESERVED by bob`（有效、未逾期），視圖 `seat-9 = AVAILABLE`（**view ≠ truth**）；第三人 carol 依視圖下單被 `currently reserved` 擋下——幽靈可售席位。
- **根因**：SeatMap `set` 無條件覆寫、無 expected-owner/expected-status 檢查（`game.ts:132–135`）。E3 在 harness 中交錯距離是微任務級；生產中該窗口是兩次跨物件呼叫的網路間隙（與 R2 的付款視窗同數量級）——窗口寬度屬推論，次序合法性屬實測。
- **既有覆蓋**：S2（`integration_scenarios.test.ts:81–128`）釘的是「bob 已**成交 SOLD**、release 回 false」路徑（#22 修復本身）；「release 回 true 之後才被插隊」的次序無任何測試覆蓋。

### 3.4 R4【推論】扣款非冪等 × `ctx.run` at-least-once → 崩潰重放可重複扣款

`processPayment`（`payment_new.ts:3–21`）不帶冪等鍵；mock gateway（`index.ts:14–31`）也不去重。Restate 的 `ctx.run` 對 side effect 是 at-least-once：結果寫入 journal 前崩潰→重放→閉包再執行一次。正常流程中「同一票第二人付款」會被 Ticket 狀態機擋下（E1 顯示重置後的例外反而繞過了它），所以日常雙扣需要 crash-重放路徑。沙箱不模擬持久化／重播（`integration.ts:24–29`、`fake-restate-sdk.mjs:13–18`），故**只能推論**；需生產 Restate E2E（`test-all.sh` 範疇）驗證。修復方向見 §5.2 方案 E。

### 3.5 R5【推論】#21 副作用：reserve 回覆若於 journal 遺失，使用者被自己的保留鎖出 15 分鐘

`reserve` 現行對「RESERVED by 自己」也拋 `TerminalError`（`game.ts:38–44`）。同一 invocation 的重試由 journal 重放、理論上不重呼 handler（repo 的宣稱：`game.test.ts:41–44` 註解）；但若「物件端已提交 reserve、回覆未及寫入 journal」的損窗口語意不如宣稱，重放會以「自己的幽靈保留」拒死後續所有重試，直到 TTL 到期。此保證只能在生產 E2E 確認（與 R4 同一張驗證工作項）。

---

## 4. 影響範圍

| 面向 | 受影響者 | 路徑 |
|---|---|---|
| 資金 | 已扣款卻失去座位的使用者（R1、R2、R4）：損失 100/筆且無申訴／退款通道（程式層面不存在退款操作） | `checkout.ts:22–28,44`、`game_manager.ts:16`、`payment_new.ts` |
| 票務真值 | 同一座位對兩個「Booking Confirmed」持有者有效（R1）；UI 顯示可售而實際不可售（R3）；幽靈保留導致合法持票人重試被拒（R5） | `game.ts:92–99,132–151` |
| 下游消費者 | SeatMap `get` 的所有讀者（前端座位圖、`load-test*.js` 壓力測試）在 R1/R3 後讀到與真值不一致的畫面；發信服務對已失效交易發出「Confirmed」（R1 後 user-1 的信件成為虛假憑證） | `game.ts:162–165`、`utils/email.ts` |
| 模組 | `src/checkout.ts`、`src/game.ts`、`src/game_manager.ts`、`src/utils/payment_new.ts`、`src/index.ts`；測試缺口：`test/integration_scenarios.test.ts`（S5 缺席）、`specs/checkout.qnt`（模型未含 reset 交錯與退款語意的跡象） | — |
| 流程 | Issue #17→#21/#22 的修復鏈只覆蓋「釋放守衛」與「false 不回寫」，本報告指出其檢查-行動原子性殘缺（R3）與補償範圍缺口（R2）尚未閉合 | — |

## 5. 方案比較

### 5.1 R2（付款後補償缺口）——主軸

| 方案 | 內容 | 評估 |
|---|---|---|
| **A（建議）補償範圍對稱化＋退款操作** | 把 `confirm`＋SOLD 回寫包入同一 `try`；新增 `refund(amount, paymentRef)`（`payment_new.ts`）與「付款成功但後續失敗」的補償分支：退款 →（若仍持有則）釋放 → 視圖回寫；退款本身置於 `ctx.run` 以便重試。 | 與現有 saga 結構一致、最小語意變更；需要新退款原語。驗收可用 E2 的交錯直接寫成測試（修復前紅、後綠）。 |
| B confirm 前置（reserve→confirm(pending)→付款→paid 標記） | 先取得票權再付款。 | **拒**：付款失敗改需「取消已 confirm 票」的反向操作，把同一缺口搬到別處；且直接衝擊 #21/#22 已釘的守衛語意與 S1–S4 測試，改動面最大、可回滾性最差。 |
| C 只把 confirm 進 try、失敗即 release | 不加退款，僅釋放。 | **拒**：release 對已扣款不解決資金滯留（錢還在系统方），等於把「無票也無錢」變成「有票也無錢」；S3 註解所期望的「修復收斂」若止於此，characterization 翻綠也沒有誠實性。 |
| D TTL 延長／付款期間續約 | 把 reservedUntil 在 run 前後刷新。 | **拒（作為修復）**：只縮窄 R2 觸發窗口，不改變「confirm 在補償範圍外」的結構根因；作為緩解可與 A 併行。 |

### 5.2 其他

- **R1**：建議＝重置改為「有守衛的釋放」——`GameManager.reset` 只釋放 `RESERVED`（含逾期）票，SOLD 屬已收款交易，不得無條件回收；若回合語意必須全清，則以「回合終局事件＋對 SOLD 持有者退款或轉贈」显式建模（方案細節交人类裁定，因涉商業規則）。被拒＝關閉 auto-reset（load test／產品回合設計依賴它）。
- **R3**：建議＝SeatMap 條件寫入：`set({seatId, status, expectedStatus?/expectedOwner?})`，補償回寫只在「當前值仍是本人造成的值」時生效，否則丟棄（視圖收斂交給下一次真值事件）。被拒＝把補償改成「先寫視圖再釋放」——兩步仍非原子，窗口只是搬到另一邊。
- **R4**：建議＝付款帶冪等鍵（invocation id／`(ticketId,userId)`），gateway 去重；被拒＝假設 journal 給 exactly-once（語意是 at-least-once）。
- **R5**：建議＝生產 E2E 驗證 journal 重放保證後再決定是否給 reserve 加「同 invocation 冪等」豁免；在此之前不動（避免回退 #21）。

## 6. 建議下一步（可直接開成工作項）

| # | 類型 | 標題 | 驗收條件草案（可觀察結果） |
|---|---|---|---|
| WI-1 | agent-fix-bug | 補償範圍對稱化：付款後失敗須退款＋收斂（R2，含 S3 characterization 翻綠） | ① 新增整合測試：以受控時鐘＋run hook 重現本報告 E2 時序，斷言修復後「退款 run 被執行、票券不殘留本人保留、SeatMap 與真值一致、`TerminalError` 仍外拋」；修復前紅／後綠。② `src/utils/payment_new.ts` 提供 `refund` 且被補償路徑以 `ctx.run` 呼叫。③ `npm test` 全綠、既有 64 條斷言不刪減（S3 的 RESERVED 殘留斷言允許翻為修復語意並在 PR 描述引用本報告）。 |
| WI-2 | agent-fix-bug | GameManager.reset 不得回收已 SOLD 票券（R1） | ① 新增整合測試：50 席完整售出→重置投遞→對 seat-1 再次 checkout，斷言第二次結帳必須失敗（或走明确退款分支，依人類裁定），不得出現同席兩次 `confirm` 成功；修復前紅／後綠。② `release()` 無參數呼叫的 SOLD 特例以显式參數（如 `allowSold`）取代，重置呼叫端同步更新；`game.test.ts:182–188` 的 characterization 依裁定翻綠或改寫並在 PR 說明。③ `npm test` 全綠。 |
| WI-3 | agent-add-tests | 把本報告 E1–E3 固化為回歸測試（含補齊 Issue #17 缺席的 S5） | ① E3（release=true 後視圖覆蓋）以真實 handler 次序寫成整合測試，斷言現況 view≠truth（characterization，`it.skip` 或註明現況），並附「修復後應成立」的斷言方向。② 於 Issue #17 上下文確認 S5 原意並補測或留言記錄缺席原因。③ 全部在既有實作上綠燈（characterization 除外，依 add-tests 規則 `it.skip` 交付）。 |
| WI-4 | agent-analyze（雲端） | 生產 Restate 環境驗證 R4/R5：ctx.run at-least-once 與 reserve 重放語意 | ① 於 `test-all.sh`／workerd 部署以 kill-and-resume 注入崩潰，觀察 process-payment 實際執行次數與 reserve 重放行為。② 產出證據報告至 `docs/research/`，不做程式變更。 |
| WI-5 | agent-fix-bug（低優先） | SeatMap 條件寫入消滅 R3 窗口 | ① `set` 支援 expected-owner/status 參數；補償回寫僅在條件成立時生效。② WI-3 的 E3 characterization 測試翻綠（視圖恆等於真值或最終收斂）。③ `npm test` 全綠。 |

依 docs/06 §4，以上僅為分析與方案，放行與開單由人類審查決定。

---

## 附錄 A：重現腳本與執行紀錄

腳本 `dist/scratch/repro_ap1.mjs`（`dist/` 為建置輸出、已被 `.gitignore` 忽略，刻意不進 repo；以下原樣可貼回執行）：

```js
import { createIntegration } from "../test/helpers/integration.js";

// E1：50 席完整結帳 → auto-reset → seat-1 再次完整售出
async function e1() {
  const itg = createIntegration();
  for (let i = 1; i <= 50; i++)
    await itg.checkout.process({ ticketId: `seat-${i}`, userId: `user-${i}`, paymentMethodId: "card_success" });
  await itg.drain();                       // 投遞 GameManager.reset（含 50 張無身分 release）
  await itg.checkout.process({ ticketId: "seat-1", userId: "mallory", paymentMethodId: "card_success" });
  // 斷言：seat-1 confirm 真實 handler 對 user-1 與 mallory 各成功一次；無任何退款/release 補償
}

// E2：受控時鐘＋run hook 於「付款完成、confirm 前」推進 TTL 並讓 bob 搶購
async function e2() {
  const t0 = 1_000_000;
  const itg = createIntegration(t0);
  let injected = false;
  itg.world.hooks.after = async (label) => {
    if (label !== "process-payment" || injected) return;
    injected = true;
    itg.world.now = () => t0 + 16 * 60 * 1000;
    await itg.checkout.process({ ticketId: "seat-7", userId: "bob", paymentMethodId: "card_success" });
  };
  await itg.checkout.process({ ticketId: "seat-7", userId: "alice", paymentMethodId: "card_success" });
  // 斷言：alice 已扣款、seat-7 上 release 呼叫 0 次、不發信、終端失敗
}

// E3：程式碼容許的真實 handler 次序重現補償回寫 TOCTOU
async function e3() {
  const itg = createIntegration();
  await itg.ticket("seat-9").reserve("alice");
  await itg.seatMap.set({ seatId: "seat-9", status: "RESERVED" });
  const released = await itg.ticket("seat-9").release("alice"); // → true（檢查當下 Alice 仍持有）
  await itg.ticket("seat-9").reserve("bob");
  await itg.seatMap.set({ seatId: "seat-9", status: "RESERVED" });
  await itg.seatMap.set({ seatId: "seat-9", status: "AVAILABLE" }); // Alice 依過期判斷的回寫
  // 斷言：真值 RESERVED(bob)、視圖 AVAILABLE、carol 依視圖下單被拒
}
```

執行命令與結果（本 run 實測）：

```bash
npm run build:tests   # 環境注意：本機需 npm ci --legacy-peer-deps（lockfile 中 wrangler@4.127.1
                      # peer 要求 workers-types ^5，root dev 錨 ^4，ERESOLVE；未改任何設定檔）
node --import ./test/loader/register.mjs --import ./test/loader/test-setup.mjs dist/scratch/repro_ap1.mjs
# → 13/13 [OK]，RESULT: ALL-REPRO-CONFIRMED
npm test              # 64 pass / 0 fail / 0 skipped（基線全綠）
```

## 附錄 B：實測／推論對照表

| 結論 | 等級 |
|---|---|
| E1 雙重銷售時序＋無退款（handler 級、真實 handler） | 實測 |
| E2 付款後 confirm 失敗＋零補償時序（交錯由 hook 注入，harness 模擬應用層序列化） | 實測（生產停頓原因屬推論） |
| E3 次序合法性與 view≠truth | 實測；生產窗口寬度＝推論 |
| R1 的 soldCount≥50 在生產必然可達 | 推論（碼路確定，環境頻率未量測） |
| R4、R5 | 推論（需 E2E） |
| 基線 `build:tests`／`npm test` 全綠 | 實測 |

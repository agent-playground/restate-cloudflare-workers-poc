**是的，經實測驗證，目前線上運行的後端服務 `https://nexus-poc.philipz.workers.dev/` 確實存在嚴重的重複訂位、票券篡改與雙重成交（Double Booking / Double Sale）問題！**

我們透過 Cloudflare Workers 部署版本檢查以及連接 Restate Cloud Ingress 進行線上實時測試，獲得了 100% 確鑿的實測證據：

---

### 一、線上部署版本溯源（歷史證據）

透過 Wrangler 查詢目前線上活躍版本：

- **目前線上版本**：Version `c0d16a35-f13a-4ab1-abf1-64e73c806fec`
- **線上部署時間**：**2025-12-10 14:53:11 UTC**
- **對應 Git 提交**：歷史 Commit [`a97d2d0`](file:///Users/cfh00805122/lab/playground/restate/restate-cloudflare-workers-poc/src/game.ts)

  ```git
  commit a97d2d077fbfd6849c1ea1b3ba42d08d9dbefe3b
  Author: philipz <philipzheng@gmail.com>
  Date:   Tue Dec 2 14:53:32 2025 +0800

      fix: allow confirming tickets that are already sold or available to prevent race condition errors
  ```

  > 📌 **分析**：線上目前跑的正是 2025 年 12 月當初為了「掩蓋賽兵報錯」而引入 `if (state.status === "SOLD") return true;` 與 `AVAILABLE` 放寬確認邏輯的原始有缺陷版本，後續在 `fix/checkout-concurrency` 分支上的修復尚未發布至線上。

---

### 二、線上即時實測驗證（實測證據）

我們透過 `.env` 連線至線上 Restate Cloud（`https://201kb7y8wxs1nk6t81wyx88dn2q.env.us.restate.cloud:8080`）進行測試（測試席位：`audit-test-seat-1788487118`）：

#### 1. 致命驗證：票已賣給 Bob，Alice 呼叫 `confirm` 依然回傳成功（雙重成交 RC2）

```bash
# 1. Bob 預訂並完成確認
curl -X POST "$RESTATE_CLOUD_URL/Ticket/audit-seat/reserve" -d '"bob"'   # 回傳: true
curl -X POST "$RESTATE_CLOUD_URL/Ticket/audit-seat/confirm" -d '"bob"'   # 回傳: true

# 2. 查詢當前狀態：確實已被 Bob 買走
# 狀態: {"status":"SOLD","reservedBy":"bob","reservedUntil":null}

# 3. 此時以 Alice 身分呼叫 confirm（模擬 Alice 付款完成後請款）：
curl -X POST "$RESTATE_CLOUD_URL/Ticket/audit-seat/confirm" -d '"alice"'
# 👉 線上實際回傳: true  💥
```

- **後果**：
  在線上的 `Checkout.process` 流程中，Alice 的 Saga 見 `ticket.confirm()` 回傳 `true`，**會直接發送「Booking Confirmed」信件給 Alice**。
  **結果：系統只賣一張票，Bob 與 Alice 兩人都付款了、兩人都收到「購買成功確認」，但票真值只歸 Bob 所有，Alice 遭到奪票。**

---

#### 2. 致命驗證：第三方可直接釋放他人的有效保留（RC1）

```bash
# 1. Alice 成功預約票券
curl -X POST "$RESTATE_CLOUD_URL/Ticket/audit-seat/reserve" -d '"alice"'
# 狀態: {"status":"RESERVED","reservedBy":"alice", ...}

# 2. 模擬未授權的第三方 Bob（或非同步 GameManager.reset）呼叫 release：
curl -X POST "$RESTATE_CLOUD_URL/Ticket/audit-seat/release" -d '"bob"'
# 👉 線上實際回傳: true
# 狀態立即變成: {"status":"AVAILABLE","reservedBy":null} 💥
```

- **後果**：
  Alice 正在填寫信用卡付款時，任何背景重置或他人的補償請求可以直接呼叫 `release` 撕毀 Alice 的保留，將票釋出給其他人搶購。

---

#### 3. 致命驗證：未經預訂即可將 AVAILABLE 席位轉為 SOLD

```bash
# 對一張全新的空票（AVAILABLE）直接發起 confirm：
curl -X POST "$RESTATE_CLOUD_URL/Ticket/new-seat/confirm" -d '"eve"'
# 👉 線上實際回傳: true
# 狀態直接變成: {"status":"SOLD","reservedBy":null} 💥
```

- **後果**：
  完全繞過 `reserve` 與結帳流程，空票可被直接確認為已售出，且擁有者為 `null`。

---

### 三、總結與修復建議

| 測試情境                 | 線上實測行為                  | 是否有重複訂位/競態漏洞？             |
| :----------------------- | :---------------------------- | :------------------------------------ |
| **已售給他人時 confirm** | 盲目回傳 `true`，判定結帳成功 | ❌ **有嚴重漏洞（造成雙重成交）**     |
| **他人付款中途 release** | 無條件清空為 `AVAILABLE`      | ❌ **有嚴重漏洞（付款中被插隊搶票）** |
| **未經預訂直接 confirm** | 允許直接售出                  | ❌ **有狀態機越權漏洞**               |

**處置建議**：
目前在 `fix/checkout-concurrency` 分支中，我們已加入：

1. `confirm(userId)` 持有者認領守衛
2. `release(userId)` 呼叫者保護守衛
3. `test/race_counterexample.test.ts` 自動化測試

建議將 `fix/checkout-concurrency` 分支合併後，執行 `npm run deploy` 部署最新程式碼至 Cloudflare Workers，即可徹底解決線上重複訂位與搶票問題。

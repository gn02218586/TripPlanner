# TripPlanner：行程規劃地圖

TripPlanner 是一個純前端的靜態網站，用來在地圖上規劃多天行程：

- 介面：純 HTML、CSS、JavaScript（ES modules），不需要 build 工具，可以直接放在 GitHub Pages。
- 地圖：Google Maps JavaScript API。
- 資料：Firebase（Authentication 與 Firestore）。
- 帳號：一個帳號代表一團人，每個帳號只看得到自己的專案；管理員帳號可以看到全部。同一份規劃可以多人同時編輯，有即時同步、存檔衝突保護和歷史快照。

> 本 README 提到的專案資料夾一律稱為 **TripPlanner**。

---

## 檔案結構

```
TripPlanner/
├─ index.html            進入頁（含 <meta name="robots" content="noindex">）
├─ config.example.js     設定範本
├─ config.js             你的金鑰設定（自行填入）
├─ firestore.rules       Firestore 安全規則（貼到 Firebase 主控台）
├─ css/style.css
└─ js/
   ├─ main.js            進入點與網址路由
   ├─ firebase.js        Firebase 初始化（CDN 模組版 SDK）
   ├─ maps-loader.js     Google Maps 動態載入（importLibrary）
   ├─ state.js           單一資料來源與所有修改動作
   ├─ store.js           Firestore 讀寫、2 秒合併存檔、transaction 版本檢查、即時監聽、歷史快照
   ├─ routes.js          路線計算（記憶體 → Firestore 快取 → Routes API）
   ├─ schedule.js        時間表、冬季係數、包車／結束時間／住宿檢查
   ├─ markers.js         標記與圖示（地圖、行程、備用庫共用）
   ├─ map-view.js        地圖畫面
   ├─ itinerary-view.js  行程流程（右上）
   ├─ backup-view.js     備用庫（右下）與「參考其他規劃」
   ├─ ui-common.js       共用小元件
   ├─ dnd.js             SortableJS 拖曳設定
   ├─ export.js          匯出 JSON／純文字
   ├─ seed.js            種子資料「北海道測試」
   ├─ utils.js           小工具
   └─ screens/
      ├─ login.js  projects.js  plans.js  planner.js  project-form.js  common.js
```

---

## 1. 本機測試

ES modules 不能用 `file://` 直接開啟，需要一個本機伺服器。

1. 先完成下面第 2、4 節，把金鑰填進 `config.js`。
2. 在 TripPlanner 資料夾開啟終端機，執行：

   ```bash
   python -m http.server 8000
   ```

3. 瀏覽器開啟 <http://localhost:8000/>。
4. 登入後到「選擇專案」畫面，按「初始化測試資料（北海道測試）」，就會建立範例專案。

> 如果 `config.js` 裡還是 `YOUR_...` 這類佔位符，網頁會顯示「尚未設定」。

---

## 2. Google Cloud 設定

### 2-1 建立專案並綁定帳單
1. 前往 <https://console.cloud.google.com/>，在左上角的專案選單選「新增專案」，名稱可以取 `tripplanner`。
2. 進入「帳單」，把專案連結到一個帳單帳戶。Google Maps Platform 一定要有帳單帳戶才能使用；每個 SKU 都有每月免費額度，見第 3 節。

### 2-2 啟用 API
到「API 和服務 → 程式庫」，搜尋並啟用以下三個 API：
- **Maps JavaScript API**
- **Places API (New)**：請選名稱有 (New) 的那個，不要選舊版 Places API。
- **Routes API**

本專案不使用、也不需要啟用以下 API：
- Geocoding API
- 舊版 Directions API
- 舊版 Distance Matrix API
- 舊版 Places API

### 2-3 建立 Map ID
Advanced Markers（新式標記）需要 Map ID。
1. 到「Google Maps Platform → 地圖管理（Map Management）」，按「建立地圖 ID」。
2. 類型選 **JavaScript**，向量或點陣都可以。
3. 把產生的 Map ID 填進 `config.js` 的 `MAP_ID`。

### 2-4 建立 API 金鑰並設定限制
1. 到「API 和服務 → 憑證」，選「建立憑證 → API 金鑰」。
2. 編輯這把金鑰，在「應用程式限制」選 **網站（HTTP 參照網址）**，加入：
   - `http://localhost:8000/*`
   - `https://你的GitHub帳號.github.io/TripPlanner/*`
3. 在「API 限制」選「限制金鑰」，只勾選這三個：
   - Maps JavaScript API
   - Places API (New)
   - Routes API
4. 把金鑰填進 `config.js` 的 `GOOGLE_MAPS_API_KEY`。

> **前端金鑰本來就會公開。** 網站部署後，任何人打開瀏覽器開發者工具都看得到 `config.js` 裡的金鑰，這是所有前端地圖網站的正常狀況。保護金鑰靠兩件事：
> - **HTTP 網址限制**：只有你的網址能使用這把金鑰。
> - **API 限制**：這把金鑰只能呼叫指定的 API。
>
> 再加上每日配額上限與預算警示，就能控制風險。Firebase 的資料則由 Firestore 規則保護：沒有登入就不能讀寫。

### 2-5 設定每日配額上限
到「API 和服務 → 已啟用的 API」，點進每個 API 的「配額與系統限制（Quotas & System Limits）」，找到以「per day」計的請求配額，編輯成較低的上限。建議值：

| API | 建議每日上限 |
|---|---|
| Routes API（Compute Routes） | 300 |
| Places API (New)：Autocomplete | 300 |
| Places API (New)：Place Details | 300 |
| Maps JavaScript API：地圖載入 | 500 |

> 配額名稱會隨 Google 改版略有不同，找「每日（per day）」的請求數即可。超過上限時當天的查詢會失敗，隔天自動恢復。

### 2-6 設定預算警示
1. 到「帳單 → 預算與快訊」，建立預算，例如每月 USD 5。
2. 設定 50%、90%、100% 時寄送 Email 通知。

> 預算警示只會通知，**不會自動停用服務**。真正擋住用量的是上一步的配額上限。

---

## 3. 費用說明

以下依 2026 年查證的官方頁面整理。價格與額度可能調整，**請以官方頁面為準**：
- <https://developers.google.com/maps/billing-and-pricing/pricing>
- <https://developers.google.com/maps/billing-and-pricing/sku-details>

| 功能 | 本專案的用法 | 計費 SKU（等級） | 每月免費額度 |
|---|---|---|---|
| 地圖顯示 | 每次載入地圖 | Dynamic Maps（Essentials） | 10,000 次 |
| 搜尋框 | PlaceAutocompleteElement 輸入時的建議 | Autocomplete Requests（Essentials） | 10,000 次 |
| 選取搜尋結果 | `fetchFields(['id','location'])`；名稱直接用候選文字 `placePrediction.mainText` | Place Details Essentials | 10,000 次 |
| 建專案時搜尋區域 | `fetchFields(['id','location','viewport'])` | Place Details Essentials | 同上 |
| 點地圖上的 POI | `fetchFields(['displayName','location'])`，**displayName 屬 Pro** | Place Details Pro | 5,000 次 |
| 路線：開車 DRIVE | `Route.computeRoutes`，明確指定 `TRAFFIC_UNAWARE` | Compute Routes Essentials | 10,000 次 |
| 路線：步行 WALK | 同上 | Compute Routes Essentials（見下方說明） | 同上 |
| 路線：大眾運輸 TRANSIT | 同上，帶 departureTime | Compute Routes Essentials（見下方說明） | 同上 |

說明：
- **Routes 的計費等級**：
  - 官方列出的 Pro 觸發條件有四種：11–25 個中途點、`optimizeWaypointOrder`、`TRAFFIC_AWARE` 或 `TRAFFIC_AWARE_OPTIMAL`、路側／車頭方向／vehicle stopover 等位置修飾。
  - Enterprise 觸發條件有四種：機車路線、過路費計算、polyline 帶路況、大型車路線。
  - 本專案都不使用這些功能，只取 `distanceMeters`、`durationMillis`、`path`。
  - 官方 SKU 頁面沒有明列 WALK 與 TRANSIT 屬於哪一級。因為它們不在 Pro 和 Enterprise 的觸發清單中，依「沒用到 Pro/Enterprise 功能就是 Essentials」的規則推論為 Essentials。
- **搜尋的 session**：PlaceAutocompleteElement 會自動使用 session token；選取後第一次 `fetchFields` 會結束該 session。實際的 session 計費方式請參考官方 Places API (New) 計費說明。
- **一個請求只依最高等級計費**：請求的欄位裡只要有一個屬於 Pro，整次就算 Pro。所以本專案在搜尋時刻意不取 `displayName`。
- **省用量的設計**：
  - 路線有兩層快取：先查記憶體，再查 Firestore 的 `routeCache`。同專案所有規劃共用，同一段路全專案只查一次。
  - 查不到路線也會快取起來，避免重複查詢。
  - 「其他」交通方式完全不查。
  - 拖動標記時不計算，放開後 800ms 才算，而且只重算有變動的路段。
- **Firebase**：本專案的用量很小，通常落在 Firestore 免費額度內（每天讀取 5 萬次、寫入 2 萬次、儲存 1 GiB）。

---

## 4. Firebase 設定

1. 前往 <https://console.firebase.google.com/>，選「新增專案」，再選**你在第 2 節建立的 Google Cloud 專案**，把 Firebase 加到同一個專案。
2. 進入「專案設定 → 一般 → 你的應用程式」，按 `</>`（網頁）註冊一個應用程式，不需要 Firebase Hosting。
3. 把畫面上的 `firebaseConfig` 內容填進 `config.js`。
4. **開啟 Email/密碼登入**：到「Authentication → 登入方式（Sign-in method）」，啟用「電子郵件/密碼」。
5. **建立帳號**：到「Authentication → 使用者 → 新增使用者」建立帳號（詳見下方「多帳號與管理員」）。
   - **第一個先建立管理員帳號** `gn02218586@tripplanner.app`。Email 登入不會驗證信箱，管理員帳號沒先建立的話，別人可以搶先註冊成這個 Email。
   - 每一團建立一個帳號，例如 `japan2028@tripplanner.app`，把帳號名稱（`japan2028`）與密碼分享給該團的人。
6. **授權網域**：到「Authentication → 設定 → 已授權的網域」，加入 `你的GitHub帳號.github.io`。`localhost` 預設已在清單中。
7. **建立 Firestore**：
   1. 到「Firestore Database → 建立資料庫」。
   2. 位置建議選 `asia-northeast1`（東京）或 `asia-east1`（台灣）。建立後無法更改。
   3. 模式選「正式版模式（production mode）」。
8. **貼上規則**：
   1. 到「Firestore Database → 規則」，把 TripPlanner 資料夾裡 `firestore.rules` 的內容整段貼上，按「發布」。
   2. 詳細位置：Firebase 主控台 → 選這個專案 → 左側「建構（Build）」→「Firestore Database」→ 上方「規則（Rules）」頁簽 → 把原本內容全部取代 → 按「發布（Publish）」。
   3. 這份規則的效果是：管理員可讀寫全部；一般帳號只能讀寫「擁有帳號」等於自己的專案與其底下所有資料；未登入不能讀寫任何資料。
   4. 不需要安裝 firebase CLI，也不需要 `firebase.json`。
10. （建議）**關閉自行註冊**：到「Authentication → 設定 → 使用者動作（User actions）」，取消勾選「啟用建立（註冊）」，只讓你在後台建立的帳號能登入。

### 多帳號與管理員

- **登入**：帳號欄位輸入 `japan2028` 會自動補成 `japan2028@tripplanner.app`；輸入含「@」的帳號（例如 `tripplanner@example.com`）則照原樣登入。
- **暱稱**：登入畫面可選填暱稱，存在這台電腦的瀏覽器，用來顯示「建立者／最後修改」；沒填就顯示帳號名稱（@ 前面那段）。點右上角 👤 可以修改。
- **專案歸屬**：每個專案記錄「擁有帳號」（`ownerEmail`，小寫），建立專案時自動填入目前帳號。一般帳號只看得到、也只能讀寫自己擁有的專案（含規劃、歷史、路線快取、專案備用庫）。
- **管理員**：帳號設定在 `js/accounts.js` 的 `ADMIN_EMAIL`，`firestore.rules` 的 `isAdmin()` 也寫了同一個 Email，**換管理員時兩處都要改**，規則要重新發布。
  - 首頁依擁有帳號分組顯示全部專案，可展開收合；沒有擁有帳號的舊專案歸在「未歸屬」，只有管理員看得到。
  - 在「專案設定」的「擁有帳號」欄位可以指定或轉移（輸入 `hokkaido` 自動補成 `hokkaido@tripplanner.app`），轉移前會確認。
- **刪除專案**：在首頁分支圖的「專案設定」最下方。會先刪除所有規劃（含歷史）、路線快取與專案備用庫，最後才刪專案本身。
- **從單一共用帳號改成多帳號的順序**：
  1. 在 Authentication 建立管理員與各團帳號。
  2. 上傳新版程式（舊規則下新程式也能運作）。
  3. 用管理員登入，把「未歸屬」的專案轉給對應帳號。
  4. 最後才發布新的 `firestore.rules`。如果先發布，轉移前一般帳號看不到任何專案。
9. （建議）限制 Firebase 的 API 金鑰：
   1. 到 Google Cloud「憑證」頁，找到 Firebase 自動建立的 Browser key。
   2. 加上 HTTP 網址限制：`localhost` 與 GitHub Pages 網址，另外加上 `你的專案ID.firebaseapp.com/*`。

### 資料結構（Firestore）
```
projects/{projectId}
  name, ownerEmail（擁有帳號，小寫）, creatorNickname, bounds{n,s,e,w}, startDate, numDays, defaultMode, winterFactor,
  defaultCharterHours, latestEndTime, defaultStart{點}, defaultEnd{點}, createdAt
projects/{projectId}/routeCache/{key}     key = 起點lat,lng_終點lat,lng_交通方式（6 位小數）
  distanceMeters, durationSec, noRoute, path（encoded polyline）, createdAt
projects/{projectId}/plans/{planId}
  name, creator, lastEditor, updatedAt, version, lastSessionId, days[], backup{tabs[]}
projects/{projectId}/plans/{planId}/history/{autoId}
  savedAt, editor, snapshot{days, backup}
```

---

## 5. GitHub Pages 部署

1. 到 <https://github.com/> 註冊帳號。
2. 右上角選「＋ → New repository」：
   - Repository name 填 **TripPlanner**。這個名稱會成為網址的一部分：`https://你的帳號.github.io/TripPlanner/`。
   - 選 **Public**。免費方案的 GitHub Pages 需要公開 repo；搭配 `noindex` 與登入保護，資料不會外流。
3. 上傳檔案：
   1. 在 repo 頁面選「Add file → Upload files」。
   2. 把 TripPlanner 資料夾**裡面的所有檔案與資料夾**拖進去，包含 `config.js`。
   3. 按「Commit changes」。
4. 開啟 Pages：
   1. 到 repo 的「Settings → Pages」。
   2. Source 選「Deploy from a branch」，Branch 選 `main`，資料夾選 `/ (root)`，按 Save。
   3. 約一兩分鐘後，網址 `https://你的帳號.github.io/TripPlanner/` 就能使用。
5. 確認第 2-4 節的 HTTP 網址限制，以及第 4 節的授權網域，都已加入這個網址。

> 程式內一律使用相對路徑，所以 repo 名稱改了也能運作。改名後記得同步更新金鑰的網址限制。

---

## 6. 用完後如何關閉

**關閉網站**
- 到 GitHub repo 的「Settings → Pages」，按「Unpublish site」；或在「Settings → General → Danger Zone」選「Delete this repository」。

**刪除 Google Cloud 專案**（Firebase 也會一起刪除）
1. 到 Google Cloud 主控台「IAM 與管理 → 設定」，按「關閉（Shut down）」，輸入專案 ID 確認。專案會先進入 30 天待刪除期，期滿後永久刪除，期間內可以復原。
2. 也可以先到「帳單 → 帳戶管理」把專案的帳單停用，這樣就不會再產生任何費用。
3. 到「帳單 → 預算與快訊」刪除不需要的預算。

---

## 使用說明

**進站流程**：輸入帳號、密碼（暱稱選填）登入 → 在專案列表點選專案，右側展開該專案的規劃分支 → 點規劃進入主畫面。

**主畫面配置**：左邊是地圖，右上是行程流程，右下是備用庫。中間的分隔線可以拖動調整大小，▾ 可以收起備用庫。

**加入地點**有三種方式：
- 用上方搜尋框。
- 點地圖上的 POI，或點空白處（會建立可改名的「自訂地點」）。
- 從備用庫拖曳到行程。拖曳是複製，備用庫會保留該點。

**排序與移動**：
- 行程可以拖曳排序，也可以拖到別天。
- 拖回備用庫會從行程移除。
- 拖到備用庫的頁簽按鈕上，可以移到該頁簽。

**路段與時間**：
- 每段路可以改交通方式，或按 ✏️ 手動輸入時間，按 ↺ 恢復 Google 時間。
- 開車時間會乘上冬季係數；手動時間不乘。
- 地點變更後，有手動時間的路段會顯示黃色警示。

**檢查提示**：每天底部會提示包車超時、超過最晚結束時間、這天還沒安排住宿。

**多人共用**：
- 存檔會在停止編輯 2 秒後自動進行。
- 別人修改時會即時同步；如果發生衝突，會讓你選擇「載入對方的版本」或「確定覆蓋」。
- 「歷史」可以一鍵還原最近 20 筆快照。

**匯出**：可以匯出 JSON 或純文字行程表，支援複製與下載。

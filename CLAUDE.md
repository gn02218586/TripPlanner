# TripPlanner 工作規則

## 上傳（git commit／push）
- 使用者說「上傳」時，**commit 前一定先執行 `python tools/bump_version.py`** 更新版本號。
  - 會同時更新 `version.json`、`js/version.js` 的 `APP_VERSION`、`index.html` 與所有 JS import 網址的 `?v=版本號`。
  - 不要手動改 `?v=`；所有檔案必須是同一個版本號（不一致會讓同一個模組被載入兩份）。
- push 前先列出變更的檔案，等使用者確認。
- commit 說明用繁體中文，簡短描述這次改了什麼功能。
- 使用者說「標記版本 XXX」時，建立 git tag 並 push。

## 範圍
- 只能讀寫 TripPlanner 資料夾內的檔案；不做全域安裝、不改環境變數。
- 金鑰用佔位符（config.js 由使用者自己填）。
- 程式內一律使用相對路徑。
- firestore.rules 修改時提供全文，由使用者自己貼到 Firebase 主控台發布。

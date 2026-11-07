// 設定範本：複製成 config.js 後填入自己的值。
// 注意：這些前端金鑰部署後任何人都看得到（這是正常的），
// 安全性靠 Google Cloud 的「HTTP 網址限制 + API 限制」與 Firestore 規則保護，詳見 README。

// Google Maps Platform API 金鑰
export const GOOGLE_MAPS_API_KEY = 'YOUR_GOOGLE_MAPS_API_KEY';

// 地圖 ID（Advanced Markers 需要）；在 Google Cloud 主控台「地圖管理」建立
export const MAP_ID = 'YOUR_MAP_ID';

// Firebase 專案設定（Firebase 主控台 → 專案設定 → 一般 → 你的應用程式 → SDK 設定）
export const firebaseConfig = {
  apiKey: 'YOUR_FIREBASE_API_KEY',
  authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT_ID.firebasestorage.app',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID',
};

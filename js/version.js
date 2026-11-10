// 網站版本：防止新舊檔案混用
// - APP_VERSION 與 version.json 由 tools/bump_version.py 統一更新（每次上傳前執行），不要手動修改
// - 網站開著時每 5 分鐘、以及切回分頁時，用不快取的方式讀 version.json；版本不同就在上方顯示「網站已更新」橫幅
// - 點橫幅重新整理；有尚未儲存的修改時，先存檔、等存好再重新載入
import { h } from './utils.js?v=2026-11-10-1';

export const APP_VERSION = '2026-11-10-1';

const CHECK_MS = 5 * 60 * 1000;
const SAVE_WAIT_MS = 15 * 1000;

// 尚未儲存的修改（登入後由 main.js 接上 store 的函式）
let hooks = { hasUnsaved: () => false, saveAll: async () => {} };
export function setUnsavedHooks(h2) { hooks = { ...hooks, ...h2 }; }

let banner = null;
let latest = null;
let timer = null;

async function check() {
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const v = String((await res.json())?.version || '');
    if (v && v !== APP_VERSION) { latest = v; showBanner(); }
  } catch { /* 離線或讀取失敗：下次再試 */ }
}

function showBanner() {
  if (!banner) {
    banner = h('button', { class: 'update-banner', type: 'button', onClick: reloadSafely });
    document.body.append(banner);
  }
  if (!banner.dataset.busy) banner.textContent = '網站已更新，請按這裡重新整理';
  banner.title = `目前版本 ${APP_VERSION}，最新版本 ${latest}`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 重新整理前先存檔：等規劃與備用庫都存好才重新載入；存不了（衝突、失敗）就提示，不重新載入 */
async function reloadSafely() {
  if (banner.dataset.busy) return;
  if (!hooks.hasUnsaved()) { location.reload(); return; }
  banner.dataset.busy = '1';
  banner.textContent = '正在儲存尚未儲存的修改，存好後自動重新整理…';
  try { await hooks.saveAll(); } catch (e) { console.warn(e); }
  const t0 = Date.now();
  while (hooks.hasUnsaved() && Date.now() - t0 < SAVE_WAIT_MS) await sleep(300);
  delete banner.dataset.busy;
  if (hooks.hasUnsaved()) {
    banner.textContent = '還有修改沒有存好（可能存檔失敗或有衝突），請先處理後再按這裡重新整理';
    return;
  }
  location.reload();
}

/** 開始檢查（啟動時呼叫一次） */
export function startVersionCheck() {
  if (timer) return;
  timer = setInterval(check, CHECK_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  check();
}

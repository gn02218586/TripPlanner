// 進入點：檢查設定 → 登入 → 依網址（#/、#/p/專案、#/p/專案/規劃、#/lib/專案、#/accounts）切換畫面
import { GOOGLE_MAPS_API_KEY, MAP_ID, firebaseConfig } from '../config.js?v=2026-11-10-1';
import { h } from './utils.js?v=2026-11-10-1';
import { startVersionCheck, setUnsavedHooks } from './version.js?v=2026-11-10-1';

const app = document.getElementById('app');

const unconfigured = [GOOGLE_MAPS_API_KEY, MAP_ID, firebaseConfig?.apiKey, firebaseConfig?.projectId]
  .some(v => !v || String(v).startsWith('YOUR_'));

if (unconfigured) {
  app.replaceChildren(h('div', { class: 'center-screen' }, h('div', { class: 'card' },
    h('h1', {}, '尚未設定'),
    h('p', {}, '請在 config.js 填入 GOOGLE_MAPS_API_KEY、MAP_ID 與 firebaseConfig（參考 config.example.js 與 README）。'))));
} else {
  startVersionCheck();   // 網站更新時提示重新整理（新舊檔案混用時也能提醒）
  start().catch(e => {
    console.error(e);
    app.replaceChildren(h('div', { class: 'center-screen' }, h('div', { class: 'card' },
      h('p', { class: 'error' }, '啟動失敗：' + e.message),
      h('div', { class: 'row' }, h('button', { class: 'primary', onClick: () => location.reload() }, '重新整理')),
      h('p', { class: 'small muted' }, '如果一直出現，請按 Ctrl + F5（Mac：Cmd + Shift + R）強制重新整理。'))));
  });
}

async function start() {
  const { auth, onAuthStateChanged } = await import('./firebase.js?v=2026-11-10-1');
  const { state } = await import('./state.js?v=2026-11-10-1');
  const { getProject, hasUnsaved, hasUnsavedLibrary, saveNow, saveLibraryNow } = await import('./store.js?v=2026-11-10-1');
  // 「網站已更新」重新整理前：先把規劃與備用庫尚未儲存的修改存好
  setUnsavedHooks({
    hasUnsaved: () => hasUnsaved() || hasUnsavedLibrary(),
    saveAll: () => Promise.all([saveNow(), saveLibraryNow()]),
  });
  const { mountLogin } = await import('./screens/login.js?v=2026-11-10-1');
  const { mountProjects } = await import('./screens/projects.js?v=2026-11-10-1');
  const { mountPlanner } = await import('./screens/planner.js?v=2026-11-10-1');
  const { mountLibrary } = await import('./screens/library.js?v=2026-11-10-1');
  const { refreshNickname } = await import('./screens/common.js?v=2026-11-10-1');
  const { mountAccounts } = await import('./screens/accounts.js?v=2026-11-10-1');
  const { startPresence, stopPresence, startPresenceWatch, stopPresenceWatch, setPresenceScreen } = await import('./presence.js?v=2026-11-10-1');
  const { isAdmin } = await import('./accounts.js?v=2026-11-10-1');

  let cleanup = null;
  let token = 0;

  async function route() {
    const my = ++token;
    if (cleanup) { const c = cleanup; cleanup = null; try { await c(); } catch (e) { console.error(e); } }
    if (my !== token) return;
    if (!state.user) { cleanup = mountLogin(app); return; }
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    try {
      // 別的帳號的專案：規則拒絕讀取（permission-denied），與不存在一樣處理
      const loadProject = (id) => getProject(id).catch(e => {
        if (e?.code === 'permission-denied') return null;
        throw e;
      });
      if (parts[0] === 'p' && parts[1] && parts[2]) {
        // #/p/專案/規劃：地圖畫面
        const project = await loadProject(parts[1]);
        if (my !== token) return;
        if (!project) { showNoAccess(); return; }
        state.project = project;
        const c = await mountPlanner(app, project, parts[2]);
        if (my !== token) { await c(); return; }
        cleanup = c;
      } else if (parts[0] === 'lib' && parts[1]) {
        // #/lib/專案：專案備用庫編輯畫面
        const project = await loadProject(parts[1]);
        if (my !== token) return;
        if (!project) { showNoAccess(); return; }
        state.project = project;
        const c = await mountLibrary(app, project);
        if (my !== token) { await c(); return; }
        cleanup = c;
      } else if (parts[0] === 'accounts') {
        // #/accounts：帳號管理（只有管理員）
        state.project = null;
        if (!isAdmin()) { showNoAccess(); return; }
        setPresenceScreen({ kind: 'accounts', text: '帳號管理' });
        const c = await mountAccounts(app);
        if (my !== token) { await c(); return; }
        cleanup = c;
      } else {
        // #/ 或 #/p/專案：專案列表（後者自動展開該專案的分支）
        state.project = null;
        setPresenceScreen({ kind: 'home', text: '首頁' });
        const c = await mountProjects(app, parts[0] === 'p' ? parts[1] || null : null);
        if (my !== token) { await c(); return; }
        cleanup = c;
      }
    } catch (e) {
      console.error(e);
      app.replaceChildren(h('div', { class: 'center-screen' }, h('div', { class: 'card' },
        h('p', { class: 'error' }, '載入失敗：' + e.message), h('a', { href: '#/' }, '回專案列表'))));
    }
  }

  function showNoAccess() {
    app.replaceChildren(h('div', { class: 'center-screen' }, h('div', { class: 'card' },
      h('p', { class: 'error' }, '沒有權限或專案不存在'), h('a', { href: '#/' }, '回專案列表'))));
  }

  window.addEventListener('hashchange', route);
  onAuthStateChanged(auth, async (user) => {
    state.user = user;
    if (user) {
      refreshNickname();   // 暱稱：這台瀏覽器存的 → 帳號名稱
      startPresence();     // 線上狀態回報（每個分頁一份）
      if (isAdmin()) startPresenceWatch(); else stopPresenceWatch();
    } else {
      stopPresence();
      stopPresenceWatch();
    }
    route();
  });
}

// 進入點：檢查設定 → 登入 → 依網址（#/、#/p/專案、#/p/專案/規劃、#/lib/專案）切換畫面
import { GOOGLE_MAPS_API_KEY, MAP_ID, firebaseConfig } from '../config.js';
import { h } from './utils.js';

const app = document.getElementById('app');

const unconfigured = [GOOGLE_MAPS_API_KEY, MAP_ID, firebaseConfig?.apiKey, firebaseConfig?.projectId]
  .some(v => !v || String(v).startsWith('YOUR_'));

if (unconfigured) {
  app.replaceChildren(h('div', { class: 'center-screen' }, h('div', { class: 'card' },
    h('h1', {}, '尚未設定'),
    h('p', {}, '請在 config.js 填入 GOOGLE_MAPS_API_KEY、MAP_ID 與 firebaseConfig（參考 config.example.js 與 README）。'))));
} else {
  start().catch(e => {
    console.error(e);
    app.replaceChildren(h('div', { class: 'center-screen' }, h('div', { class: 'card error' }, '啟動失敗：' + e.message)));
  });
}

async function start() {
  const { auth, onAuthStateChanged } = await import('./firebase.js');
  const { state } = await import('./state.js');
  const { getProject } = await import('./store.js');
  const { mountLogin } = await import('./screens/login.js');
  const { mountProjects } = await import('./screens/projects.js');
  const { mountPlanner } = await import('./screens/planner.js');
  const { mountLibrary } = await import('./screens/library.js');
  const { refreshNickname } = await import('./screens/common.js');

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
      } else {
        // #/ 或 #/p/專案：專案列表（後者自動展開該專案的分支）
        state.project = null;
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
    if (user) refreshNickname();   // 暱稱：這台瀏覽器存的 → 帳號名稱
    route();
  });
}

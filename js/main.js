// 進入點：檢查設定 → 登入 → 暱稱 → 依網址（#/、#/p/專案、#/p/專案/規劃）切換畫面
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
  const { mountPlans } = await import('./screens/plans.js');
  const { mountPlanner } = await import('./screens/planner.js');
  const { ensureNickname } = await import('./screens/common.js');

  let cleanup = null;
  let token = 0;

  async function route() {
    const my = ++token;
    if (cleanup) { const c = cleanup; cleanup = null; try { await c(); } catch (e) { console.error(e); } }
    if (my !== token) return;
    if (!state.user) { cleanup = mountLogin(app); return; }
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    try {
      if (parts[0] === 'p' && parts[1]) {
        const project = await getProject(parts[1]);
        if (my !== token) return;
        if (!project) { location.hash = '#/'; return; }
        state.project = project;
        const c = parts[2] ? await mountPlanner(app, project, parts[2]) : await mountPlans(app, project);
        if (my !== token) { await c(); return; }
        cleanup = c;
      } else {
        state.project = null;
        cleanup = await mountProjects(app);
      }
    } catch (e) {
      console.error(e);
      app.replaceChildren(h('div', { class: 'center-screen' }, h('div', { class: 'card' },
        h('p', { class: 'error' }, '載入失敗：' + e.message), h('a', { href: '#/' }, '回專案列表'))));
    }
  }

  window.addEventListener('hashchange', route);
  onAuthStateChanged(auth, async (user) => {
    state.user = user;
    if (user) await ensureNickname();
    route();
  });
}

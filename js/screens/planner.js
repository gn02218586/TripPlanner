// 主畫面：左地圖、右上行程流程、右下備用庫（專案共用、可直接編輯）；頂部列含存檔狀態、歷史、匯出、專案設定
import { state, on, mutate, forEachLeg, deriveCharterTable, selectStop } from '../state.js';
import {
  startPlanSession, endPlanSession, listHistory, restoreSnapshot, hasUnsaved, saveNow, updateProject,
  migratePlanBackups, startLibrarySession, endLibrarySession, hasUnsavedLibrary, saveLibraryNow,
} from '../store.js';
import { initRouteCache, requestRoutes, getRouteInfo } from '../routes.js';
import { computeSchedule } from '../schedule.js';
import { createMapView } from '../map-view.js';
import { createItineraryView } from '../itinerary-view.js';
import { createBackupView } from '../backup-view.js';
import { openExport } from '../export.js';
import { openProjectForm } from './project-form.js';
import { topBar } from './common.js';
import { h, debounce, toast, openModal, confirmDialog, promptDialog, fmtDateTime, transitDepartureDate } from '../utils.js';

const SPLIT_KEY = 'tripplanner.backupHeight';
const ROUTE_DEBOUNCE = 800;

export async function mountPlanner(app, project, planId) {
  const offs = [];
  state.selectedDay = null;
  state.selectedStop = null;
  state.selectedStartOf = null;
  state.hoverBackup = null;

  app.replaceChildren(h('div', { class: 'center-screen' }, h('div', { class: 'muted' }, '載入規劃中…')));
  // 舊資料轉移：各規劃的本規劃備用點合併到專案備用庫（只做一次；失敗時保留舊資料，下次再試）
  try {
    const r = await migratePlanBackups(project.id);
    if (r?.plans) toast(`已把 ${r.plans} 個規劃的備用點合併到專案備用庫`, 'ok', 6000);
  } catch (e) {
    console.warn('備用點轉移失敗', e);
    toast('舊的備用點合併失敗，下次開啟時會再試：' + e.message, 'warn', 6000);
  }
  // 規劃與備用庫各自一個編輯工作階段（各自自動存檔、版本衝突檢查、即時同步）
  await Promise.all([initRouteCache(project.id), startPlanSession(project.id, planId), startLibrarySession(project.id)]);

  // 舊資料轉換（一次性）：專案還沒有「每日包車時數」表時，依這份規劃舊的每日覆蓋值建立
  if (!Array.isArray(project.charterHoursByDay)) {
    const table = deriveCharterTable(project, state.plan);
    project.charterHoursByDay = table;
    updateProject(project.id, { charterHoursByDay: table })
      .then(() => toast('已把每日包車時數移到專案設定'))
      .catch(e => console.warn('包車時數轉換失敗', e));
  }

  // ---------- 時間表（依資料變動快取） ----------
  let schedCache = null;
  const invalidate = () => { schedCache = null; };
  offs.push(on('plan', invalidate), on('routes', invalidate));
  const getSchedule = () => (schedCache ||= computeSchedule(state.plan, state.project));

  // ---------- 版面 ----------
  const statusEl = h('span', { class: 'save-status' }, '已儲存');
  const planNameBtn = h('button', { class: 'link-btn plan-name', title: '重新命名規劃', onClick: renamePlan }, state.plan.name);
  const banner = h('div', { class: 'banner hidden' });
  const mapEl = h('div', { class: 'map' });
  const itinEl = h('div', { class: 'itinerary' });
  const splitter = h('div', { class: 'splitter', title: '拖動調整大小' });
  const backupEl = h('div', { class: 'backup' });
  const side = h('div', { class: 'side' }, itinEl, splitter, backupEl);
  const root = h('div', { class: 'planner' },
    topBar([
      h('a', { href: `#/p/${project.id}`, class: 'link-btn', title: '返回專案列表（自動展開這個專案）' }, '← 專案列表'),
      h('span', { class: 'proj-name' }, project.name), h('span', { class: 'muted' }, '/'), planNameBtn, statusEl,
    ], [
      h('button', { class: 'small-btn', onClick: openHistory }, '歷史'),
      h('button', { class: 'small-btn', onClick: openExport }, '匯出'),
      h('button', { class: 'small-btn', onClick: openSettings }, '專案設定'),
    ]),
    banner,
    h('div', { class: 'main' }, mapEl, side));
  app.replaceChildren(root);

  // 分隔線拖動
  try { const hgt = +localStorage.getItem(SPLIT_KEY); if (hgt > 60) backupEl.style.height = hgt + 'px'; } catch { /* 忽略 */ }
  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    const rect = side.getBoundingClientRect();
    const move = (ev) => {
      const hgt = Math.max(80, Math.min(rect.height - 140, rect.bottom - ev.clientY));
      backupEl.style.height = hgt + 'px';
    };
    const up = () => {
      splitter.removeEventListener('pointermove', move);
      try { localStorage.setItem(SPLIT_KEY, parseInt(backupEl.style.height, 10)); } catch { /* 忽略 */ }
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up, { once: true });
  });
  const toggleCollapse = (collapsed) => side.classList.toggle('backup-collapsed', collapsed);

  // ---------- 子畫面 ----------
  const mapView = await createMapView(mapEl, { getSchedule });
  const itinView = await createItineraryView(itinEl, { getSchedule, mapView });
  const backupView = createBackupView(backupEl, { mapView, onToggleCollapse: toggleCollapse });

  // ---------- 路線計算（變動後 debounce 800ms，只查快取沒有的 key） ----------
  function syncLegResults() {
    // 把 Google 結果寫回 leg（不觸發存檔，隨下次修改一起存）
    forEachLeg(state.plan, (from, s) => {
      const inf = getRouteInfo(from, s, s.leg.mode);
      if (inf.status === 'ok' || inf.status === 'noRoute') {
        s.leg.gKey = inf.key;
        s.leg.gDist = inf.status === 'ok' ? inf.distanceMeters : null;
        s.leg.gSec = inf.status === 'ok' ? inf.durationSec : null;
      }
    });
  }
  function requestAll() {
    const sched = getSchedule();
    const jobs = [];
    state.plan.days.forEach((day, di) => day.stops.forEach((s, i) => {
      const st = sched[di]?.stops[i];
      if (!st?.from || !s.leg || s.leg.mode === 'other') return;
      jobs.push({
        from: st.from, to: s, mode: s.leg.mode,
        departAt: s.leg.mode === 'transit' ? transitDepartureDate(day.date, st.legStart) : null,
      });
    }));
    requestRoutes(jobs);
  }
  const debouncedRequest = debounce(requestAll, ROUTE_DEBOUNCE);
  offs.push(on('plan', () => { planNameBtn.textContent = state.plan.name; debouncedRequest(); }));
  offs.push(on('routes', syncLegResults));
  offs.push(on('routesRetry', requestAll));
  requestAll();

  // ---------- 存檔狀態與別人的修改 ----------
  // 規劃與備用庫兩邊的狀態合併顯示：都存好才是「已儲存」；有衝突／失敗優先顯示
  const STATUS = { saved: '已儲存', dirty: '尚未儲存…', saving: '儲存中…', error: '存檔失敗', conflict: '有衝突' };
  const RANK = { conflict: 4, error: 3, saving: 2, dirty: 1, saved: 0 };
  const st = { plan: 'saved', lib: 'saved' };
  const showStatus = () => {
    const s = RANK[st.plan] >= RANK[st.lib] ? st.plan : st.lib;
    statusEl.textContent = STATUS[s] || s;
    statusEl.dataset.s = s;
    statusEl.title = `規劃：${STATUS[st.plan]}／備用庫：${STATUS[st.lib]}`;
  };
  offs.push(on('saveStatus', (s) => { st.plan = s; showStatus(); }));
  offs.push(on('libSaveStatus', (s) => { st.lib = s; showStatus(); }));
  const remoteBanner = (text) => ({ apply }) => {
    banner.replaceChildren(
      h('span', {}, text),
      h('button', { class: 'primary', onClick: () => { apply(); banner.classList.add('hidden'); } }, '載入'),
      h('button', { onClick: () => banner.classList.add('hidden') }, '稍後'));
    banner.classList.remove('hidden');
  };
  offs.push(on('remoteChange', (d) => remoteBanner(`「${d.who}」剛修改了這個規劃，是否載入？（會捨棄你尚未儲存的變更）`)(d)));
  offs.push(on('libRemoteChange', (d) => remoteBanner(`「${d.who}」剛修改了備用庫，是否載入？（會捨棄你尚未儲存的備用庫變更）`)(d)));
  offs.push(on('plan', () => { if (!hasUnsaved() && !hasUnsavedLibrary()) banner.classList.add('hidden'); }));
  offs.push(on('library', () => { if (!hasUnsaved() && !hasUnsavedLibrary()) banner.classList.add('hidden'); }));

  // Esc 取消選取行程點（輸入框中按 Esc 不處理）
  const onKey = (e) => {
    if (e.key !== 'Escape' || !state.selectedStop) return;
    if (e.target.closest?.('input,textarea,select') || document.querySelector('.modal-overlay')) return;
    selectStop(null);
  };
  document.addEventListener('keydown', onKey);

  const beforeUnload = (e) => {
    if (!hasUnsaved() && !hasUnsavedLibrary()) return;
    saveNow(); saveLibraryNow();
    e.preventDefault(); e.returnValue = '';
  };
  window.addEventListener('beforeunload', beforeUnload);

  async function renamePlan() {
    const v = await promptDialog('重新命名規劃', state.plan.name);
    if (v && v !== state.plan.name) mutate(p => { p.name = v; });
  }

  async function openHistory() {
    const body = h('div', { class: 'history' }, h('div', { class: 'muted' }, '載入中…'));
    const m = openModal({ title: '歷史快照（最近 20 筆）', body, wide: true });
    try {
      const items = await listHistory(project.id, planId);
      body.replaceChildren(...(items.length ? items.map(it => {
        const stops = it.snapshot?.days?.reduce((n, d) => n + d.stops.length, 0) ?? 0;
        return h('div', { class: 'row-item card' },
          h('div', { class: 'grow' }, h('strong', {}, fmtDateTime(it.savedAt)), h('span', { class: 'small muted' }, `　${it.editor || '—'}・行程 ${stops} 點`)),
          h('button', { onClick: async () => {
            if (!(await confirmDialog(`還原到 ${fmtDateTime(it.savedAt)} 的版本？\n目前內容會被取代（仍可再從歷史還原）。`, '還原'))) return;
            restoreSnapshot(it.snapshot, mutate); m.close(); toast('已還原', 'ok');
          } }, '還原'));
      }) : [h('div', { class: 'muted' }, '目前沒有快照')]));
    } catch (e) { body.replaceChildren(h('div', { class: 'error' }, '讀取失敗：' + e.message)); }
  }

  function openSettings() {
    openProjectForm({
      project: state.project,
      plan: state.plan,
      onSaved: async (id, data) => {
        const boundsChanged = data.bounds && JSON.stringify(data.bounds) !== JSON.stringify(state.project.bounds);
        Object.assign(state.project, data);
        if (boundsChanged) { await Promise.all([saveNow(), saveLibraryNow()]); location.reload(); return; }
        mutate(() => {}); // 天數、日期、包車時數、冬季係數等變更：重新正規化、重算並存檔
      },
    });
  }

  return async () => {
    window.removeEventListener('beforeunload', beforeUnload);
    document.removeEventListener('keydown', onKey);
    state.selectedStop = null; state.hoverBackup = null;
    debouncedRequest.cancel();
    offs.forEach(f => f());
    mapView.destroy(); itinView.destroy(); backupView.destroy();
    await Promise.all([endPlanSession(), endLibrarySession()]);
    state.plan = null; state.planId = null; state.library = null;
  };
}

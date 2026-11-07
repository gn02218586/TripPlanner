// 單一資料來源：目前專案、規劃與畫面狀態；所有修改經由 mutate()，再以事件通知地圖與清單。
import { uid, addDays, samePlace, coordKey } from './utils.js';

export const state = {
  user: null,
  nickname: '',
  project: null,      // { id, ...projectDoc }
  planId: null,
  plan: null,         // 規劃文件內容
  selectedDay: null,  // 目前選中的天（index）或 null
  activeTab: null,    // 備用庫目前頁簽 id
  showAllBackup: false,
  refPlan: null,      // 參考中的其他規劃 { id, name, backup }
};

const listeners = {};
export function on(evt, fn) {
  (listeners[evt] ||= new Set()).add(fn);
  return () => listeners[evt].delete(fn);
}
export function emit(evt, data) {
  listeners[evt]?.forEach(fn => { try { fn(data); } catch (e) { console.error(e); } });
}

export const TYPES = ['spot', 'food', 'hotel', 'airport'];
export const TYPE_LABEL = { spot: '景點', food: '餐廳', hotel: '住宿', airport: '機場' };
export const DEFAULT_STAY = { spot: 60, food: 60, hotel: 0, airport: 0 };
export const MODES = ['drive', 'transit', 'walk', 'other'];
export const MODE_LABEL = { drive: '開車', transit: '大眾運輸', walk: '步行', other: '其他' };
export const HOTEL_TAB_KIND = 'hotel';

/** 修改規劃：fn(plan) 直接改，之後正規化並通知；save=false 時不觸發存檔 */
export function mutate(fn, { save = true } = {}) {
  if (!state.plan) return;
  fn(state.plan);
  normalizePlan(state.plan, state.project);
  if (save) emit('dirty');
  emit('plan');
}

// ---------- 建立資料 ----------
export const newLeg = (mode) => ({ mode, gDist: null, gSec: null, gKey: null, manualMin: null, manualFrom: null, manualTo: null });

export function newDay(project, i) {
  return {
    date: addDays(project.startDate, i), departTime: '09:00', charter: true,
    charterHours: null, winterFactor: null, stops: [],
  };
}

export function makeStop(pt) {
  const type = TYPES.includes(pt.type) ? pt.type : 'spot';
  return {
    id: uid(), name: pt.name || '自訂地點', placeId: pt.placeId || null,
    lat: +pt.lat, lng: +pt.lng, type,
    stayMin: pt.stayMin ?? DEFAULT_STAY[type], note: pt.note || '', leg: null,
  };
}

export function makeBackupItem(pt, tab) {
  const type = tab?.kind === HOTEL_TAB_KIND ? 'hotel' : (TYPES.includes(pt.type) ? pt.type : 'spot');
  return {
    id: uid(), name: pt.name || '自訂地點', placeId: pt.placeId || null,
    lat: +pt.lat, lng: +pt.lng, type,
    stayMin: pt.stayMin ?? DEFAULT_STAY[type], note: pt.note || '', addedBy: state.nickname,
  };
}

export function defaultTabs() {
  return [{ id: uid(), name: '備用景點', items: [] }, { id: uid(), name: '備用住宿', kind: HOTEL_TAB_KIND, items: [] }];
}

/** 空白規劃：只有預設起訖點與兩個預設頁簽 */
export function blankPlanData(project) {
  const days = Array.from({ length: project.numDays }, (_, i) => newDay(project, i));
  if (project.defaultStart) days[0].stops.push(makeStop({ ...project.defaultStart, type: project.defaultStart.type || 'airport' }));
  if (project.defaultEnd) days[days.length - 1].stops.push(makeStop({ ...project.defaultEnd, type: project.defaultEnd.type || 'airport' }));
  const plan = { days, backup: { tabs: defaultTabs() } };
  normalizePlan(plan, project);
  return plan;
}

/** 正規化：天數補齊、日期重算、每個路段都有 leg、第一點沒有 leg */
export function normalizePlan(plan, project) {
  if (!plan || !project) return;
  plan.days ||= [];
  while (plan.days.length < project.numDays) plan.days.push(newDay(project, plan.days.length));
  while (plan.days.length > project.numDays && plan.days[plan.days.length - 1].stops.length === 0) plan.days.pop();
  plan.days.forEach((d, i) => {
    d.date = addDays(project.startDate, i);
    d.stops ||= [];
    d.departTime ||= '09:00';
    if (d.charter === undefined) d.charter = true;
    if (d.charterHours === undefined) d.charterHours = null;
    if (d.winterFactor === undefined) d.winterFactor = null;
  });
  let seenFirst = false;
  for (const d of plan.days) {
    for (const s of d.stops) {
      if (!seenFirst) { s.leg = null; seenFirst = true; continue; }
      if (!s.leg) s.leg = newLeg(project.defaultMode || 'drive');
    }
  }
  plan.backup ||= { tabs: [] };
  if (!plan.backup.tabs?.length) plan.backup.tabs = defaultTabs();
  if (plan === state.plan && !plan.backup.tabs.some(t => t.id === state.activeTab)) state.activeTab = plan.backup.tabs[0].id;
}

// ---------- 查詢 ----------
/** 某點的「前一點」：同天前一點；當天第一點則為之前最近一天的最後一點 */
export function prevPoint(plan, dayIdx, idx) {
  if (idx > 0) return plan.days[dayIdx].stops[idx - 1];
  for (let d = dayIdx - 1; d >= 0; d--) {
    const st = plan.days[d].stops;
    if (st.length) return st[st.length - 1];
  }
  return null;
}

/** 走訪每個路段 cb(from, toStop, dayIdx, idx) */
export function forEachLeg(plan, cb) {
  plan.days.forEach((d, di) => d.stops.forEach((s, i) => {
    const from = prevPoint(plan, di, i);
    if (from && s.leg) cb(from, s, di, i);
  }));
}

export function findStop(id, plan = state.plan) {
  for (let di = 0; di < plan.days.length; di++) {
    const idx = plan.days[di].stops.findIndex(s => s.id === id);
    if (idx >= 0) return { dayIdx: di, idx, stop: plan.days[di].stops[idx] };
  }
  return null;
}

export function findBackup(itemId, plan = state.plan) {
  for (const tab of plan.backup.tabs) {
    const idx = tab.items.findIndex(i => i.id === itemId);
    if (idx >= 0) return { tab, idx, item: tab.items[idx] };
  }
  return null;
}

export const getTab = (id) => state.plan.backup.tabs.find(t => t.id === id);

/** 備用點已排入哪幾天（回傳 1 起算的天數陣列） */
export function scheduledDays(item, plan = state.plan) {
  const out = [];
  plan.days.forEach((d, i) => { if (d.stops.some(s => samePlace(s, item))) out.push(i + 1); });
  return out;
}

export const dayCharterHours = (day) => day.charterHours ?? state.project.defaultCharterHours;
export const dayWinter = (day) => day.winterFactor ?? state.project.winterFactor ?? 1;

// ---------- 動作 ----------
export function addStopToDay(dayIdx, pt, index = null) {
  mutate(p => {
    const st = p.days[dayIdx].stops;
    const s = makeStop(pt);
    if (index == null || index > st.length) st.push(s); else st.splice(index, 0, s);
  });
}

export function moveStop(id, toDay, toIdx) {
  mutate(p => {
    const f = findStop(id, p); if (!f) return;
    p.days[f.dayIdx].stops.splice(f.idx, 1);
    const st = p.days[toDay].stops;
    st.splice(Math.max(0, Math.min(toIdx, st.length)), 0, f.stop);
  });
}

export function updateStop(id, patch) {
  mutate(p => { const f = findStop(id, p); if (f) Object.assign(f.stop, patch); });
}

export function removeStop(id) {
  mutate(p => { const f = findStop(id, p); if (f) p.days[f.dayIdx].stops.splice(f.idx, 1); });
}

export function updateLeg(stopId, patch) {
  mutate(p => { const f = findStop(stopId, p); if (f?.stop.leg) Object.assign(f.stop.leg, patch); });
}

/** 行程點移回備用庫（從行程移除；已有同 placeId 就不重複加入） */
export function stopToBackup(id, tabId, index = null) {
  mutate(p => {
    const f = findStop(id, p); if (!f) return;
    p.days[f.dayIdx].stops.splice(f.idx, 1);
    const exists = p.backup.tabs.some(t => t.items.some(it => f.stop.placeId ? it.placeId === f.stop.placeId : coordKey(it) === coordKey(f.stop)));
    if (exists) return;
    const tab = p.backup.tabs.find(t => t.id === tabId) || p.backup.tabs[0];
    const item = makeBackupItem({ ...f.stop }, tab);
    if (index == null) tab.items.push(item); else tab.items.splice(index, 0, item);
  });
}

/** 備用點複製到行程（備用庫保留） */
export function backupToTrip(itemId, dayIdx, index = null) {
  const f = findBackup(itemId); if (!f) return;
  const it = f.item;
  addStopToDay(dayIdx, { ...it, stayMin: it.stayMin ?? DEFAULT_STAY[it.type] }, index);
}

export function addBackupItem(tabId, pt) {
  mutate(p => {
    const tab = p.backup.tabs.find(t => t.id === tabId) || p.backup.tabs[0];
    tab.items.push(makeBackupItem(pt, tab));
  });
}

export function moveBackupItem(itemId, toTabId, index = null) {
  mutate(p => {
    const f = findBackup(itemId, p); if (!f) return;
    f.tab.items.splice(f.idx, 1);
    const tab = p.backup.tabs.find(t => t.id === toTabId) || f.tab;
    if (tab.kind === HOTEL_TAB_KIND) { f.item.type = 'hotel'; f.item.stayMin = 0; }
    if (index == null) tab.items.push(f.item); else tab.items.splice(index, 0, f.item);
  });
}

export function updateBackupItem(itemId, patch) {
  mutate(p => { const f = findBackup(itemId, p); if (f) Object.assign(f.item, patch); });
}

export function removeBackupItem(itemId) {
  mutate(p => { const f = findBackup(itemId, p); if (f) f.tab.items.splice(f.idx, 1); });
}

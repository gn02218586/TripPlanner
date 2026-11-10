// 備用庫（每個專案一份，該專案所有規劃共用）：資料結構與操作
// Firestore：projects/{pid}/library/main  { tabs:[{id,name,type,items:[]}], version, updatedAt, lastEditor, lastSessionId }
// - 頁簽可自訂（新增、改名、刪除），每個頁簽記錄類型：景點／住宿／餐廳；點的類型跟著頁簽
// - 預設頁簽：備用景點、備用住宿、備用餐廳
import {
  state, emit, mutate, roBlocked, DEFAULT_STAY, addStopToDay, insertIndexFor, selectStop, normDays, resolveIndex, effectiveDays, findStop,
} from './state.js?v=2026-11-10-1';
import { uid, samePlace } from './utils.js?v=2026-11-10-1';

export const LIB_TYPES = ['spot', 'hotel', 'food'];
export const LIB_TYPE_LABEL = { spot: '景點', hotel: '住宿', food: '餐廳' };
/** 預設頁簽（舊資料的三個固定頁簽也是這些 id） */
export const DEFAULT_LIB_TABS = [
  { id: 'spot', name: '備用景點', type: 'spot' },
  { id: 'hotel', name: '備用住宿', type: 'hotel' },
  { id: 'food', name: '備用餐廳', type: 'food' },
];
export const defaultLibTabs = () => DEFAULT_LIB_TABS.map(t => ({ ...t, items: [] }));

/** 由頁簽名稱推斷類型：含「住宿」＝住宿、含「餐廳」＝餐廳、其他＝景點 */
export const inferTabType = (name) => (String(name).includes('住宿') ? 'hotel' : String(name).includes('餐廳') ? 'food' : 'spot');

/** 正規化：頁簽（沒有任何頁簽時給預設三個）、每個點的類型與停留分鐘、天數 */
export function normalizeLibrary(lib) {
  const src = Array.isArray(lib?.tabs) ? lib.tabs : [];
  const seen = new Set();
  const tabs = src.map(t => {
    let id = t.id || uid();
    if (seen.has(id)) id = uid();
    seen.add(id);
    const type = LIB_TYPES.includes(t.type) ? t.type : (LIB_TYPES.includes(t.id) ? t.id : inferTabType(t.name || ''));
    const tab = { id, name: String(t.name || '備用').trim() || '備用', type, items: [] };
    for (const it of t.items || []) tab.items.push(fixItem({ ...it }, tab));
    return tab;
  });
  return { tabs: tabs.length ? tabs : defaultLibTabs() };
}

function fixItem(it, tab) {
  it.id ||= uid();
  it.name ||= '自訂地點';
  it.placeId ||= null;
  it.lat = +it.lat; it.lng = +it.lng;
  it.type = tab.type;
  if (tab.type === 'hotel') it.stayMin = 0;
  else if (it.stayMin == null || isNaN(+it.stayMin)) it.stayMin = DEFAULT_STAY[tab.type];
  it.note ||= '';
  it.days = normDays(it.days);
  return it;
}

/** 建立備用點（類型跟著頁簽） */
export function makeLibItem(pt, tab) {
  const it = {
    id: uid(), name: pt.name || '自訂地點', placeId: pt.placeId || null, lat: pt.lat, lng: pt.lng,
    stayMin: tab.type === 'hotel' ? 0 : (pt.stayMin ?? DEFAULT_STAY[tab.type]), note: pt.note || '',
    days: normDays(pt.days), addedBy: pt.addedBy || state.nickname,
  };
  if (pt.query) it.query = pt.query;   // 匯入時的搜尋字（保留供日後參考與匯出）
  return fixItem(it, tab);
}

export function findLibItem(itemId, lib = state.library) {
  if (!lib) return null;
  for (const tab of lib.tabs) {
    const idx = tab.items.findIndex(i => i.id === itemId);
    if (idx >= 0) return { tab, idx, item: tab.items[idx] };
  }
  return null;
}
export const findLibTab = (tabId, lib = state.library) => lib?.tabs.find(t => t.id === tabId) || null;

/** 備用庫裡的同一地點（地點 ID 相同；沒有 ID 時比對座標） */
export const findSamePlace = (pt, lib = state.library) => lib?.tabs.flatMap(t => t.items).find(it => samePlace(it, pt)) || null;

/** 各頁簽點數 [{ name, type, count }] */
export const libraryCounts = (lib) => (lib?.tabs || []).map(t => ({ name: t.name, type: t.type, count: t.items.length }));
export const libraryTotal = (lib) => (lib?.tabs || []).reduce((n, t) => n + t.items.length, 0);

/** 依類型找頁簽：第一個同類型的頁簽；沒有就用第一個頁簽（機場類放景點頁簽） */
export function libTabForType(type, lib = state.library) {
  const want = type === 'hotel' ? 'hotel' : type === 'food' ? 'food' : 'spot';
  return lib.tabs.find(t => t.type === want) || lib.tabs[0];
}

/**
 * 合併進備用庫（直接修改 lib）
 * - tabSpecs：[{ name, type }] 先確保這些頁簽存在（同名頁簽合併，沒有就新增）
 * - entries：[{ tabName, tabType, pt }]；依頁簽名稱放入（沒有就新增頁簽），與現有或本次重複的地點略過
 * - mode 'replace'：先清空所有點（頁簽保留）
 * 回傳 { added, dup, newTabs }
 */
export function mergeIntoLibrary(lib, entries, { mode = 'append', tabSpecs = [] } = {}) {
  if (mode === 'replace') lib.tabs.forEach(t => { t.items = []; });
  let newTabs = 0;
  const ensureTab = (name, type) => {
    let tab = lib.tabs.find(t => t.name === name);
    if (!tab) {
      tab = { id: uid(), name, type: LIB_TYPES.includes(type) ? type : inferTabType(name), items: [] };
      lib.tabs.push(tab);
      newTabs++;
    }
    return tab;
  };
  tabSpecs.forEach(s => ensureTab(s.name, s.type));
  let added = 0, dup = 0;
  for (const { tabName, tabType, pt } of entries) {
    if (lib.tabs.some(t => t.items.some(it => samePlace(it, pt)))) { dup++; continue; }
    const tab = tabName ? ensureTab(tabName, tabType) : lib.tabs[0];
    tab.items.push(makeLibItem(pt, tab));
    added++;
  }
  return { added, dup, newTabs };
}

/** 依頁簽規格與點直接建立整個備用庫（匯入成新專案：頁簽順序、類型、空頁簽都照文字） */
export function buildLibrary(tabSpecs, entries) {
  const lib = { tabs: tabSpecs.map(s => ({ id: uid(), name: s.name, type: LIB_TYPES.includes(s.type) ? s.type : inferTabType(s.name), items: [] })) };
  if (!lib.tabs.length && !entries.length) return { lib: normalizeLibrary(null), added: 0, dup: 0, newTabs: 0 };
  const r = mergeIntoLibrary(lib, entries);
  return { lib: normalizeLibrary(lib), ...r };
}

// ---------- 編輯（經由 mutateLib 觸發存檔；規劃畫面與專案備用庫編輯畫面共用） ----------
export function mutateLib(fn, { save = true } = {}) {
  if (!state.library) return;
  if (save && state.libRO) { roBlocked(); emit('library'); return; }   // 鎖定：不修改，重繪還原畫面
  fn(state.library);
  state.library = normalizeLibrary(state.library);
  if (state.libSelected && !findLibItem(state.libSelected)) state.libSelected = null;
  if (!state.library.tabs.some(t => t.id === state.libTab)) state.libTab = state.library.tabs[0].id;
  if (state.hoverBackup && !findLibItem(state.hoverBackup.id)) state.hoverBackup = null;
  if (save) emit('libDirty');
  emit('library');
}

/** 新增；已有同一地點就不加入，回傳既有點的 id 與 added:false */
export function addLibItem(tabId, pt) {
  if (state.libRO) { roBlocked(); return null; }   // 鎖定：回傳 null
  const dup = findSamePlace(pt);
  if (dup) return { id: dup.id, added: false };
  const tab = findLibTab(tabId) || state.library.tabs[0];
  const item = makeLibItem(pt, tab);
  mutateLib(lib => { (lib.tabs.find(t => t.id === tab.id) || lib.tabs[0]).items.push(item); });
  return { id: item.id, added: true };
}

/** pos：插入位置（數字、{ before: id }、{ after: id } 或 null＝最後；見 state.resolveIndex） */
export function moveLibItem(itemId, toTabId, pos = null) {
  mutateLib(lib => {
    const f = findLibItem(itemId, lib); if (!f) return;
    f.tab.items.splice(f.idx, 1);
    const tab = lib.tabs.find(t => t.id === toTabId) || f.tab;
    const it = f.item;
    // 從住宿移出時停留分鐘恢復預設；移入住宿由 normalize 設為 0
    if (f.tab.type === 'hotel' && tab.type !== 'hotel') it.stayMin = DEFAULT_STAY[tab.type];
    tab.items.splice(resolveIndex(tab.items, pos), 0, it);
  });
}

export function updateLibItem(itemId, patch) {
  mutateLib(lib => { const f = findLibItem(itemId, lib); if (f) Object.assign(f.item, patch); });
}

export function removeLibItem(itemId) {
  mutateLib(lib => { const f = findLibItem(itemId, lib); if (f) f.tab.items.splice(f.idx, 1); });
}

// ---------- 頁簽 ----------
export function addLibTab(name, type) {
  const id = uid();
  mutateLib(lib => { lib.tabs.push({ id, name, type: LIB_TYPES.includes(type) ? type : inferTabType(name), items: [] }); });
  state.libTab = id;
  emit('library');
  return id;
}
export function renameLibTab(tabId, name) {
  mutateLib(lib => { const t = lib.tabs.find(x => x.id === tabId); if (t) t.name = name; });
}
/** 刪除頁簽（連同裡面的點）；至少保留一個頁簽 */
export function removeLibTab(tabId) {
  mutateLib(lib => { if (lib.tabs.length > 1) lib.tabs = lib.tabs.filter(t => t.id !== tabId); });
}

/**
 * 編輯畫面的天數篩選：'all'＝全部、'none'＝只顯示不限、數字（1 起算）＝只顯示標示這一天的點
 */
export function libItemMatches(it, filter = state.libDayFilter) {
  if (filter === 'all' || filter == null) return true;
  const ds = effectiveDays(it);
  return filter === 'none' ? !ds.length : ds.includes(+filter);
}

export function selectLibItem(id) {
  state.libSelected = id && state.libSelected !== id ? id : null;
  emit('libSelect');
}

// ---------- 規劃畫面：備用庫 ↔ 行程 ----------
/** 備用點複製到行程（備用庫保留原點）；index 為 'smart' 時插在選取點後面；回傳新點 id 並選取它 */
export function libToTrip(itemId, dayIdx, index = 'smart') {
  const f = findLibItem(itemId); if (!f) return null;
  const it = f.item;
  const pt = { name: it.name, placeId: it.placeId, lat: it.lat, lng: it.lng, type: it.type, stayMin: it.stayMin, note: it.note };
  const id = addStopToDay(dayIdx, pt, index === 'smart' ? insertIndexFor(dayIdx) : index);
  selectStop(id, false);
  return id;
}

/**
 * 行程點移回備用庫：從行程移除
 * - 備用庫已有同一地點（地點 ID 相同；沒有 ID 時比對座標）：不重複新增（「已排入」標籤隨之消失）
 * - 沒有：新增到指定頁簽（沒指定就依類型找頁簽），天數預設為原本那一天
 * 回傳 { existed, tabName }
 */
export function stopToLibrary(stopId, tabId = null, pos = null, days = undefined) {
  // 鎖定：行程或備用庫任一邊不能修改就整個不做（避免只改到一邊）
  if (state.planRO || state.libRO) { roBlocked(); emit('plan'); emit('library'); return { blocked: true }; }
  const f = findStop(stopId); if (!f) return null;
  const stop = { ...f.stop };
  mutate(p => { const g = findStop(stopId, p); if (g) p.days[g.dayIdx].stops.splice(g.idx, 1); });
  if (!state.library) return null;
  const exist = findSamePlace(stop);
  if (exist) return { existed: true, tabName: findLibItem(exist.id)?.tab.name || '' };
  const tab = findLibTab(tabId) || libTabForType(stop.type);
  const item = makeLibItem({ ...stop, days: days ?? [f.dayIdx + 1] }, tab);
  mutateLib(lib => {
    const t = lib.tabs.find(x => x.id === tab.id) || lib.tabs[0];
    t.items.splice(resolveIndex(t.items, pos), 0, item);
  });
  return { existed: false, tabName: tab.name };
}

// 專案備用庫（每個專案一份，該專案所有規劃共用）：資料結構與操作
// Firestore：projects/{pid}/library/main  { tabs:[{id,name,type,items:[]}], version, updatedAt, lastEditor, lastSessionId }
// 頁簽固定三個（備用景點／備用住宿／備用餐廳），點的類型跟著頁簽決定
import { state, emit, DEFAULT_STAY, addStopToDay, insertIndexFor, selectStop } from './state.js';
import { uid, samePlace } from './utils.js';

export const LIB_TABS = [
  { id: 'spot', name: '備用景點', type: 'spot' },
  { id: 'hotel', name: '備用住宿', type: 'hotel' },
  { id: 'food', name: '備用餐廳', type: 'food' },
];
/** 頁簽名稱 → 頁簽 id（匯入段落用） */
export const LIB_SECTION = Object.fromEntries(LIB_TABS.map(t => [t.name, t.id]));
export const libTabDef = (tabId) => LIB_TABS.find(t => t.id === tabId) || LIB_TABS[0];

/** 正規化：補齊三個頁簽、修正每個點的類型與停留分鐘（不認得的頁簽內容併入景點） */
export function normalizeLibrary(lib) {
  const src = Array.isArray(lib?.tabs) ? lib.tabs : [];
  const tabs = LIB_TABS.map(def => ({ id: def.id, name: def.name, type: def.type, items: [] }));
  for (const t of src) {
    const tab = tabs.find(x => x.id === t.id) || tabs[0];
    for (const it of t.items || []) tab.items.push(fixItem({ ...it }, tab));
  }
  return { tabs };
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
  return it;
}

export function makeLibItem(pt, tabId) {
  const tab = libTabDef(tabId);
  const it = {
    id: uid(), name: pt.name || '自訂地點', placeId: pt.placeId || null, lat: pt.lat, lng: pt.lng,
    stayMin: tab.type === 'hotel' ? 0 : (pt.stayMin ?? DEFAULT_STAY[tab.type]), note: pt.note || '',
    addedBy: state.nickname,
  };
  if (pt.query) it.query = pt.query;   // 匯入時的搜尋字（保留供日後參考）
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

export const libraryHasPlace = (pt, lib = state.library) => !!lib?.tabs.some(t => t.items.some(it => samePlace(it, pt)));
export const libraryCounts = (lib) => Object.fromEntries(LIB_TABS.map(d => [d.id, lib?.tabs.find(t => t.id === d.id)?.items.length || 0]));

/**
 * 匯入：把 entries [{ tabId, pt }] 合併進 lib（直接修改 lib）
 * mode 'append'＝加到現有（與現有或本次重複的略過）；'replace'＝先清空再加入
 * 回傳 { added, dup }
 */
export function mergeIntoLibrary(lib, entries, mode = 'append') {
  if (mode === 'replace') lib.tabs.forEach(t => { t.items = []; });
  let added = 0, dup = 0;
  for (const { tabId, pt } of entries) {
    if (lib.tabs.some(t => t.items.some(it => samePlace(it, pt)))) { dup++; continue; }
    const tab = lib.tabs.find(t => t.id === tabId) || lib.tabs[0];
    tab.items.push(makeLibItem(pt, tab.id));
    added++;
  }
  return { added, dup };
}

// ---------- 編輯（只在專案備用庫編輯畫面使用；經由 mutateLib 觸發存檔） ----------
export function mutateLib(fn, { save = true } = {}) {
  if (!state.library) return;
  fn(state.library);
  state.library = normalizeLibrary(state.library);
  if (state.libSelected && !findLibItem(state.libSelected)) state.libSelected = null;
  if (save) emit('libDirty');
  emit('library');
}

/** 新增；已有同一地點就不加入，回傳既有點的 id 與 added:false */
export function addLibItem(tabId, pt) {
  const dup = state.library.tabs.flatMap(t => t.items).find(it => samePlace(it, pt));
  if (dup) return { id: dup.id, added: false };
  const item = makeLibItem(pt, tabId);
  mutateLib(lib => { lib.tabs.find(t => t.id === tabId).items.push(item); });
  return { id: item.id, added: true };
}

export function moveLibItem(itemId, toTabId, index = null) {
  mutateLib(lib => {
    const f = findLibItem(itemId, lib); if (!f) return;
    f.tab.items.splice(f.idx, 1);
    const tab = lib.tabs.find(t => t.id === toTabId) || f.tab;
    const it = f.item;
    // 從住宿移出時停留分鐘恢復預設；移入住宿由 normalize 設為 0
    if (f.tab.type === 'hotel' && tab.type !== 'hotel') it.stayMin = DEFAULT_STAY[tab.type];
    if (index == null || index > tab.items.length) tab.items.push(it); else tab.items.splice(index, 0, it);
  });
}

export function updateLibItem(itemId, patch) {
  mutateLib(lib => { const f = findLibItem(itemId, lib); if (f) Object.assign(f.item, patch); });
}

export function removeLibItem(itemId) {
  mutateLib(lib => { const f = findLibItem(itemId, lib); if (f) f.tab.items.splice(f.idx, 1); });
}

export function selectLibItem(id) {
  state.libSelected = id && state.libSelected !== id ? id : null;
  emit('libSelect');
}

// ---------- 規劃畫面：共用點複製到行程（共用庫保留原點） ----------
/** index 為 'smart' 時插在選取點後面；回傳新點 id 並選取它 */
export function libToTrip(itemId, dayIdx, index = 'smart') {
  const f = findLibItem(itemId); if (!f) return null;
  const it = f.item;
  const pt = { name: it.name, placeId: it.placeId, lat: it.lat, lng: it.lng, type: it.type, stayMin: it.stayMin, note: it.note };
  const id = addStopToDay(dayIdx, pt, index === 'smart' ? insertIndexFor(dayIdx) : index);
  selectStop(id, false);
  return id;
}

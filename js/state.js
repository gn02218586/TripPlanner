// 單一資料來源：目前專案、規劃與畫面狀態；所有修改經由 mutate()，再以事件通知地圖與清單。
// 備用庫只有一份（每個專案一份，所有規劃共用），資料與操作在 library.js
import { uid, addDays, samePlace, clone, toast } from './utils.js?v=2026-11-08-2';

export const state = {
  user: null,
  nickname: '',
  project: null,      // { id, ...projectDoc }
  planId: null,
  plan: null,         // 規劃文件內容（name、days）
  selectedDay: null,  // 目前選中的天（index）或 null
  showBackupOnMap: false, // 地圖顯示備用點（目前頁簽）；預設不顯示
  selectedStop: null,     // 選取的行程點 id
  selectedStartOf: null,  // 從起點列選取時：那一天的 index
  hoverBackup: null,      // 滑鼠停留中的備用點（暫時顯示在地圖上）
  // 備用庫（library.js）
  library: null,          // { tabs:[{id,name,type,items}] }
  libTab: null,           // 目前頁簽 id
  libSelected: null,      // 編輯畫面選取的備用點 id
  backupDayMode: 'day',   // 右上選了某一天時，右下備用庫：'day'＝只顯示本日與不限、'all'＝全部
  libDayFilter: 'all',    // 專案備用庫編輯畫面的天數篩選：'all'、'none'（不限）或 1 起算的天數
  // 管理員鎖定（一般帳號唯讀）：planRO＝目前規劃的行程不能修改、libRO＝專案備用庫不能修改
  planRO: false,
  libRO: false,
  projectLocked: false,   // 目前專案是否被鎖定（即時同步）
  planLocked: false,      // 目前規劃是否被鎖定（即時同步）
};

/** 唯讀時擋下修改：提示一次（短時間內不重複） */
let roToastAt = 0;
export function roBlocked() {
  if (Date.now() - roToastAt < 2500) return;
  roToastAt = Date.now();
  toast('🔒 已被管理員鎖定，只能檢視', 'warn');
}

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
/** 舊資料（本規劃備用庫）的住宿類頁簽標記 */
export const HOTEL_TAB_KIND = 'hotel';
export const START_AIRPORT_STAY = 45;

/** 修改規劃：fn(plan) 直接改，之後正規化並通知；save=false 時不觸發存檔 */
export function mutate(fn, { save = true } = {}) {
  if (!state.plan) return;
  if (save && state.planRO) { roBlocked(); emit('plan'); return; }   // 鎖定：不修改，重繪還原畫面
  fn(state.plan);
  normalizePlan(state.plan, state.project);
  if (save) emit('dirty');
  emit('plan');
}

// ---------- 建立資料 ----------
export const newLeg = (mode) => ({ mode, gDist: null, gSec: null, gKey: null, manualMin: null, manualFrom: null, manualTo: null });

export function newDay(project, i) {
  return {
    date: addDays(project.startDate, i), departTime: '09:00', charter: true, stops: [],
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

// ---------- 備用點的「天」 ----------
// days：1 起算的天數陣列，例如 [1, 3]＝D1、D3；空陣列＝不限

/** 正規化天數：正整數、去重、排序 */
export function normDays(days) {
  if (!Array.isArray(days)) return [];
  return [...new Set(days.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 60))].sort((a, b) => a - b);
}

/** 實際有效的天數（超出專案天數的不算）；空陣列＝不限 */
export const effectiveDays = (it, numDays = state.project?.numDays ?? 60) => normDays(it?.days).filter(d => d <= numDays);

/** 備用點是否適用某一天（dayIdx 為 0 起算）：不限的點每天都適用 */
export function itemForDay(it, dayIdx, numDays) {
  const ds = effectiveDays(it, numDays);
  return !ds.length || ds.includes(dayIdx + 1);
}

/** 規劃畫面右下備用庫目前是否要依天篩選（右上選了某一天、且切換為「本日」） */
export const backupDayFilter = () => (state.selectedDay != null && state.backupDayMode === 'day' ? state.selectedDay : null);

/**
 * 插入位置：數字＝index；{ before: id }／{ after: id }＝放在某個點的前面／後面（清單有篩選時拖曳用）；null＝最後
 * 須在移除被移動的點之後計算
 */
export function resolveIndex(items, pos) {
  if (pos == null) return items.length;
  if (typeof pos === 'number') return Math.max(0, Math.min(pos, items.length));
  if (pos.before) { const i = items.findIndex(x => x.id === pos.before); if (i >= 0) return i; }
  if (pos.after) { const i = items.findIndex(x => x.id === pos.after); if (i >= 0) return i + 1; }
  return items.length;
}

/** 空白規劃：只有預設起訖點 */
export function blankPlanData(project) {
  const days = Array.from({ length: project.numDays }, (_, i) => newDay(project, i));
  if (project.defaultStart) days[0].stops.push(makeStop({ ...project.defaultStart, type: project.defaultStart.type || 'airport' }));
  if (project.defaultEnd) days[days.length - 1].stops.push(makeStop({ ...project.defaultEnd, type: project.defaultEnd.type || 'airport' }));
  const plan = { days };
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
  });
  let seenFirst = false;
  for (const d of plan.days) {
    for (const s of d.stops) {
      if (!seenFirst) {
        s.leg = null; seenFirst = true;
        // 起點機場：一次性帶入預設停留 45 分（領行李、和司機會合）
        if (s.type === 'airport' && !s.startStayInit) {
          if (!s.stayMin) s.stayMin = START_AIRPORT_STAY;
          s.startStayInit = true;
        }
        continue;
      }
      if (!s.leg) s.leg = newLeg(project.defaultMode || 'drive');
    }
  }
  if (plan === state.plan) {
    if (state.selectedStop && !findStop(state.selectedStop, plan)) { state.selectedStop = null; state.selectedStartOf = null; }
  }
}

/**
 * 選取行程點；toggle=true 時再點同一點會取消
 * startOf：從「某天的起點列」選取時為該天 index（選到的是前一天最後一點，但插入位置是這天的開頭）
 */
export function selectStop(id, toggle = true, startOf = null) {
  const same = state.selectedStop === id && (state.selectedStartOf ?? null) === startOf;
  const on = id && !(toggle && same);
  state.selectedStop = on ? id : null;
  state.selectedStartOf = on ? startOf : null;
  emit('stopSelect');
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

/** 備用點已排入目前規劃的哪幾天（回傳 1 起算的天數陣列；沒有開啟規劃時為空） */
export function scheduledDays(item, plan = state.plan) {
  const out = [];
  plan?.days.forEach((d, i) => { if (d.stops.some(s => samePlace(s, item))) out.push(i + 1); });
  return out;
}

/** 包車時數上限：讀專案設定的「每日包車時數」表（規劃內舊的每日覆蓋值不再使用） */
export const dayCharterHours = (dayIdx, project = state.project) =>
  project.charterHoursByDay?.[dayIdx] ?? project.defaultCharterHours ?? 10;
/** 冬季係數：專案統一值；勾選「每天個別設定」時讀每天的值 */
export const dayWinter = (dayIdx, project = state.project) => {
  const base = project.winterFactor ?? 1;
  return project.winterPerDay ? (project.winterFactorsByDay?.[dayIdx] ?? base) : base;
};

/** 舊資料轉換：由規劃內的每日覆蓋值產生專案的「每日包車時數」表 */
export function deriveCharterTable(project, plan) {
  return Array.from({ length: project.numDays }, (_, i) =>
    project.charterHoursByDay?.[i] ?? plan?.days?.[i]?.charterHours ?? project.defaultCharterHours ?? 10);
}

// ---------- 動作 ----------
/** 回傳新點的 id */
export function addStopToDay(dayIdx, pt, index = null) {
  const s = makeStop(pt);
  mutate(p => {
    const st = p.days[dayIdx].stops;
    if (index == null || index > st.length) st.push(s); else st.splice(index, 0, s);
  });
  return s.id;
}

/** 有選取行程點且在這一天：插在它後面；選取的是這天的起點列：插在開頭；否則 null（加在最後） */
export function insertIndexFor(dayIdx) {
  if (state.selectedStop && state.selectedStartOf === dayIdx) return 0;
  const f = state.selectedStop && state.selectedStartOf == null && findStop(state.selectedStop);
  return f && f.dayIdx === dayIdx ? f.idx + 1 : null;
}

/** 點選加入（搜尋、地圖、備用庫按鈕）：選取點那天插在選取點後面，否則加在該天最後；加入後選取新點 */
export function addStopSmart(dayIdx, pt) {
  const id = addStopToDay(dayIdx, pt, insertIndexFor(dayIdx));
  selectStop(id, false);
  return id;
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

// ---------- 規劃套用到另一個專案（管理員跨專案複製） ----------
/**
 * 把規劃的行程調整成目標專案的天數（日期一律跟著目標專案）
 * - 行程點換新 id
 * - 超出目標天數的行程點不放進行程，另外回傳（之後放進目標專案的備用庫，天數＝不限）
 * 回傳 { data:{days}, moved:[{ day, count }], movedStops:[stop] }
 */
export function fitPlanToProject(src, project) {
  const data = { days: clone(src.days || []) };
  data.days.forEach(d => (d.stops || []).forEach(s => { s.id = uid(); }));
  const n = project.numDays;
  const extra = data.days.slice(n);
  data.days = data.days.slice(0, n);
  const moved = [], movedStops = [];
  extra.forEach((d, k) => {
    const stops = d.stops || [];
    movedStops.push(...stops);
    if (stops.length) moved.push({ day: n + k + 1, count: stops.length });
  });
  normalizePlan(data, project);
  return { data, moved, movedStops };
}

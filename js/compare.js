// 備用點比較：選取的行程點 → 備用點，開車／大眾運輸／步行（沿用路線快取，同一組只查一次）
import { state, findStop, dayWinter } from './state.js';
import { computeSchedule } from './schedule.js';
import { requestRoutes, getRouteInfo } from './routes.js';
import { fmtShortDur, transitDepartureDate, parseHM } from './utils.js';

export const COMPARE_MODES = ['drive', 'transit', 'walk'];
const ICON = { drive: '🚗', transit: '🚌', walk: '🚶' };
const WALK_DIM_MIN = 60;

/** 取得目前選取的行程點（{ stop, dayIdx, idx }）或 null */
export const selectedStopInfo = () => (state.selectedStop && findStop(state.selectedStop)) || null;

/** 要求計算三種交通方式（只會查快取沒有的組合） */
export function requestCompare(item) {
  const sel = selectedStopInfo();
  if (!sel || !item) return;
  // 從起點列選取：用那一天的日期與出發時間；一般點：用該點的預計出發時間
  const startOf = state.selectedStartOf;
  let date, depMin;
  if (startOf != null && state.plan.days[startOf]) {
    date = state.plan.days[startOf].date;
    depMin = parseHM(state.plan.days[startOf].departTime);
  } else {
    date = state.plan.days[sel.dayIdx].date;
    depMin = computeSchedule(state.plan, state.project)[sel.dayIdx]?.stops[sel.idx]?.dep;
  }
  requestRoutes(COMPARE_MODES.map(mode => ({
    from: sel.stop, to: item, mode,
    departAt: mode === 'transit' ? transitDepartureDate(date, depMin) : null,
  })));
}

/**
 * 比較結果
 * 回傳 { sel, dist, path, pathMode, parts:[{mode, text, dim}], pending } 或 null（沒有選取點）
 * - 距離與路線以開車為主；開車查不到時用第一個查得到的交通方式
 * - Google 查不到的交通方式不列出；步行超過 60 分以灰色顯示
 * - 開車只顯示套用冬季係數後的時間
 */
export function compareInfo(item) {
  const sel = selectedStopInfo();
  if (!sel || !item) return null;
  const winter = dayWinter(state.selectedStartOf ?? sel.dayIdx);
  let dist = null, path = null, pathMode = null, pending = false;
  const parts = [];
  for (const mode of COMPARE_MODES) {
    const inf = getRouteInfo(sel.stop, item, mode);
    if (inf.status === 'pending') { pending = true; continue; }
    if (inf.status !== 'ok') continue;
    const min = inf.durationSec / 60;
    if (dist == null) { dist = inf.distanceMeters; path = inf.path; pathMode = mode; }
    const shown = mode === 'drive' ? min * winter : min;
    parts.push({ mode, text: `${ICON[mode]} ${fmtShortDur(shown)}`, dim: mode === 'walk' && min > WALK_DIM_MIN });
  }
  return { sel, dist, path, pathMode, parts, pending };
}

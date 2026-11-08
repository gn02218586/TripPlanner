// 時間表計算：抵達／出發時間、路段時間（冬季係數、手動時間）、每天統計與警示
import { prevPoint, dayCharterHours, dayWinter } from './state.js?v=2026-11-09-1';
import { getRouteInfo } from './routes.js?v=2026-11-09-1';
import { parseHM, coordKey } from './utils.js?v=2026-11-09-1';

/** 手動時間的起訖點是否已變更 */
export function manualMoved(leg, from, to) {
  if (leg?.manualMin == null || !leg.manualFrom || !leg.manualTo) return false;
  return coordKey(leg.manualFrom) !== coordKey(from) || coordKey(leg.manualTo) !== coordKey(to);
}

/** 單一路段的時間資訊 */
export function legDetail(leg, from, to, winter) {
  const info = getRouteInfo(from, to, leg.mode);
  const gMin = info.status === 'ok' ? info.durationSec / 60 : null;
  const adjMin = gMin != null ? (leg.mode === 'drive' ? gMin * winter : gMin) : null;
  let minutes = null, source = 'none';
  if (leg.manualMin != null) { minutes = leg.manualMin; source = 'manual'; }
  else if (adjMin != null) { minutes = adjMin; source = 'google'; }
  return {
    info, gMin, adjMin, minutes, source, winter,
    distance: info.status === 'ok' ? info.distanceMeters : null,
    moved: manualMoved(leg, from, to),
  };
}

/**
 * 計算整份規劃的時間表
 * 回傳 days[i] = { stops:[{arr, dep, legStart, leg, from}], totalDist, travelMin, start, end, charterMin, warnings[] }
 */
export function computeSchedule(plan, project) {
  const latest = parseHM(project.latestEndTime);
  const lastDayIdx = plan.days.length - 1;
  return plan.days.map((day, di) => {
    const start = parseHM(day.departTime) ?? 540;
    const winter = dayWinter(di, project);
    let t = start, totalDist = 0, travelMin = 0, lastArr = null, unknownLegs = 0;
    let charterStart = start, isTripStart = false;
    const stops = day.stops.map((s, i) => {
      const from = prevPoint(plan, di, i);
      if (!from || !s.leg) {
        // 整份行程的第一點（例如 ✈去）：當天時間為「抵達」，出發＝抵達＋停留
        const stay = +s.stayMin || 0;
        const r = { arr: start, dep: start + stay, legStart: null, leg: null, from: null, isStart: true };
        t = r.dep; charterStart = r.dep; isTripStart = true;
        return r;
      }
      const legStart = i === 0 ? start : t;      // 當天第一點：從前一天最後一點（住宿）於出發時間出發
      const leg = legDetail(s.leg, from, s, winter);
      if (leg.minutes == null) unknownLegs++;
      const arr = legStart + (leg.minutes ?? 0);
      if (leg.distance) totalDist += leg.distance;
      travelMin += leg.minutes ?? 0;
      const stay = s.type === 'hotel' ? 0 : (+s.stayMin || 0);
      const dep = arr + stay;
      t = dep; lastArr = arr;
      return { arr, dep, legStart, leg, from };
    });
    const end = lastArr;
    // 包車從出發時間起算（行程起點那天＝離開起點的時間）
    const charterMin = end != null ? end - charterStart : 0;
    const warnings = [];
    if (day.charter && end != null) {
      const limit = (dayCharterHours(di, project) || 0) * 60;
      if (limit > 0 && charterMin > limit) warnings.push({ level: 'error', text: `包車超時 ${Math.round(charterMin - limit)} 分鐘` });
    }
    if (latest != null && end != null && end > latest) warnings.push({ level: 'error', text: `最後抵達時間晚於最晚結束時間 ${project.latestEndTime}` });
    if (di < lastDayIdx) {
      const last = day.stops[day.stops.length - 1];
      if (!last || last.type !== 'hotel') warnings.push({ level: 'warn', text: '這天還沒有安排住宿' });
    }
    if (unknownLegs) warnings.push({ level: 'warn', text: `有 ${unknownLegs} 段路程尚無時間` });
    return { stops, totalDist, travelMin, start, end, charterMin, warnings, winter, isTripStart };
  });
}

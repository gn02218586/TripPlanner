// 匯入／匯出文字格式：匯出成「可以直接匯入」的文字，以及各欄位的解析
// 規則：
// - 只有一行最開頭（前面只有空白）是「#」才是註解；行尾或欄位中的 # 一律當成內容
// - 欄位以「|」分隔；名稱與備註中的「|」匯出時改成全形「｜」，換行改成「\n」兩個字元
// - 搜尋字欄位：[id:地點ID][@緯度,經度][ 搜尋文字]；有座標直接用座標，只有 ID 用 ID 取得，都沒有才搜尋
// - 天欄位：D1、D1,D3、D1、D3、1,3；空白＝不限
import { TYPE_LABEL, MODE_LABEL, dayCharterHours, normDays } from './state.js';
import { inferTabType, LIB_TYPE_LABEL, LIB_TYPES } from './library.js';
import { addDays } from './utils.js';

export const TYPE_MAP = { 機場: 'airport', 景點: 'spot', 餐廳: 'food', 住宿: 'hotel' };
export const MODE_MAP = { 開車: 'drive', 大眾運輸: 'transit', 步行: 'walk', 其他: 'other' };
/**
 * 「備用頁簽」行：列出備用庫的頁簽（順序、類型）
 * 類型預設由名稱判斷（含「住宿」＝住宿、含「餐廳」＝餐廳、其他＝景點）；
 * 判斷不出正確類型時在名稱後加（景點）／（住宿）／（餐廳）
 * 舊格式的（住宿頁簽）／（一般頁簽）標記仍可讀
 */
export const HOTEL_TAB_MARK = '（住宿頁簽）';
export const NORMAL_TAB_MARK = '（一般頁簽）';
const TYPE_MARK_RE = /（(景點|住宿|餐廳)）$/;

/** 備用段落名稱 → 預設類型 */
export const sectionType = (name) => inferTabType(name);

/** 解析「備用頁簽」行的一個項目 → { name, type } */
export function parseTabSpec(raw) {
  let name = String(raw).trim(), type = null;
  let m;
  if (name.endsWith(HOTEL_TAB_MARK)) { name = name.slice(0, -HOTEL_TAB_MARK.length).trim(); type = 'hotel'; }
  else if (name.endsWith(NORMAL_TAB_MARK)) { name = name.slice(0, -NORMAL_TAB_MARK.length).trim(); type = inferTabType(name) === 'hotel' ? 'spot' : inferTabType(name); }
  else if ((m = name.match(TYPE_MARK_RE))) {
    const t = LIB_TYPES.find(x => LIB_TYPE_LABEL[x] === m[1]);
    name = name.slice(0, -m[0].length).trim(); type = t;
  }
  return { name, type: type || inferTabType(name) };
}

// ---------- 欄位：搜尋字 ----------
const PLACE_RE = /^(?:id:([A-Za-z0-9_-]+))?\s*(?:@\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?))?\s*(.*)$/;

/**
 * 解析搜尋字欄位
 * 回傳 { placeId, lat, lng, text }（placeId／座標可能為 null）
 */
export function parsePlaceField(str) {
  const s = String(str || '').trim();
  const m = s.match(PLACE_RE);
  if (!m || (!m[1] && m[2] == null)) return { placeId: null, lat: null, lng: null, text: s };
  return { placeId: m[1] || null, lat: m[2] != null ? +m[2] : null, lng: m[3] != null ? +m[3] : null, text: (m[4] || '').trim() };
}

const coord = (v) => (+v).toFixed(6);

/** 匯出搜尋字欄位：id:地點ID@緯度,經度 搜尋文字 */
export function placeField(pt, text = '') {
  const parts = [];
  let head = pt.placeId ? `id:${pt.placeId}` : '';
  if (Number.isFinite(+pt.lat) && Number.isFinite(+pt.lng)) head += `@${coord(pt.lat)},${coord(pt.lng)}`;
  if (head) parts.push(head);
  const t = clean(text);
  if (t) parts.push(t);
  return parts.join(' ');
}

// ---------- 欄位：天 ----------
/** 解析天欄位：回傳 { days, bad }（bad＝無法辨識的片段） */
export function parseDaysField(str) {
  const s = String(str || '').trim();
  if (!s || s === '不限') return { days: [], bad: [] };
  const days = [], bad = [];
  for (const part of s.split(/[,，、\s]+/).filter(Boolean)) {
    const m = part.match(/^[Dd]?(\d+)$/);
    if (m && +m[1] >= 1) days.push(+m[1]); else bad.push(part);
  }
  return { days: normDays(days), bad };
}
export const daysField = (days) => normDays(days).map(d => 'D' + d).join(',');

// ---------- 文字清理 ----------
/** 名稱、備註：去前後空白、「|」→「｜」、換行 → \n；行首的 # 改全形（避免被當成註解） */
export function clean(s) {
  return String(s ?? '').trim().replace(/\|/g, '｜').replace(/\r?\n/g, '\\n');
}
const cleanHead = (s) => clean(s).replace(/^#/, '＃');
/** 匯入時還原備註中的換行 */
export const unescapeNote = (s) => String(s ?? '').replace(/\\n/g, '\n');

/** 頁簽名稱：「備用頁簽」行以「、」「,」「，」分隔、段落標題不能有「]」，這些字元改成「・」 */
const tabName = (t) => clean(t.name).replace(/[、,，\]\[]/g, '・');
const fmtNum = (v) => String(+v);
const mdOf = (dateStr) => { const [, m, d] = dateStr.split('-').map(Number); return `${m}/${d}`; };
const row = (cols) => cols.map(c => (c == null ? '' : String(c))).join(' | ').trimEnd();

// ---------- 匯出 ----------
/**
 * 匯出成可以直接匯入的文字
 * project：專案設定；plan：規劃（name、days）；library：專案備用庫（可為 null＝預設三個空頁簽）
 * 每個值都以固定格式輸出（座標 6 位小數、停留分鐘與交通方式一律明寫、空白的天也輸出），
 * 匯出 → 匯入 → 再匯出的文字會完全相同
 */
export function toImportText({ project, plan, library }) {
  const P = project;
  const L = [];
  L.push('# TripPlanner 匯入格式：可在首頁「匯入成新專案」或專案內「匯入行程」直接使用');
  L.push('[專案]');
  L.push(`專案名稱：${clean(P.name)}`);
  const b = P.bounds;
  if (b) L.push(`地圖範圍：北 ${coord(b.n)} 南 ${coord(b.s)} 東 ${coord(b.e)} 西 ${coord(b.w)}`);
  L.push(`開始日期：${P.startDate}`);
  L.push(`天數：${P.numDays}`);
  L.push(`預設交通方式：${MODE_LABEL[P.defaultMode || 'drive']}`);
  L.push(`冬季係數：${fmtNum(P.winterFactor ?? 1)}`);
  if (P.winterPerDay) {
    L.push(`冬季係數每天：${Array.from({ length: P.numDays }, (_, i) => fmtNum(P.winterFactorsByDay?.[i] ?? P.winterFactor ?? 1)).join('、')}`);
  }
  L.push(`每日包車時數：${Array.from({ length: P.numDays }, (_, i) => fmtNum(dayCharterHours(i, P))).join('、')}`);
  L.push(`最晚結束時間：${(P.latestEndTime || '20:00').padStart(5, '0')}`);
  if (P.defaultStart) L.push(`預設起點：${row([TYPE_LABEL[P.defaultStart.type || 'airport'], cleanHead(P.defaultStart.name), placeField(P.defaultStart)])}`);
  if (P.defaultEnd) L.push(`預設終點：${row([TYPE_LABEL[P.defaultEnd.type || 'airport'], cleanHead(P.defaultEnd.name), placeField(P.defaultEnd)])}`);
  L.push('');

  const tabs = library?.tabs?.length ? library.tabs : [
    { name: '備用景點', type: 'spot', items: [] }, { name: '備用住宿', type: 'hotel', items: [] }, { name: '備用餐廳', type: 'food', items: [] }];
  L.push(`規劃名稱：${clean(plan.name)}`);
  // 備用頁簽＝專案備用庫的頁簽；類型和名稱推不出來時才加（景點）／（住宿）／（餐廳）
  L.push(`備用頁簽：${tabs.map(t => {
    const n = tabName(t);
    // 名稱本身就以類型標記結尾時也加上標記，匯入時才不會把名稱的一部分當成標記
    const needMark = t.type !== inferTabType(n) || TYPE_MARK_RE.test(n) || n.endsWith(HOTEL_TAB_MARK) || n.endsWith(NORMAL_TAB_MARK);
    return n + (needMark ? `（${LIB_TYPE_LABEL[t.type]}）` : '');
  }).join('、')}`);
  L.push('');

  plan.days.forEach((day, di) => {
    L.push(`[Day ${di + 1} ${mdOf(addDays(P.startDate, di))}]`);
    L.push(`出發 ${(day.departTime || '09:00').padStart(5, '0')}`);
    if (day.charter === false) L.push('包車：否');
    for (const s of day.stops) {
      let mode = '';
      if (s.leg) {
        mode = MODE_LABEL[s.leg.mode] || MODE_LABEL.drive;
        if (s.leg.manualMin != null) mode += ` 手動 ${fmtNum(s.leg.manualMin)}`;
        else if (s.leg.needManual) mode += ' 手動';
      }
      L.push(row([TYPE_LABEL[s.type], clean(s.name), placeField(s), fmtNum(s.stayMin ?? 0), mode, clean(s.note)]));
    }
    L.push('');
  });

  // 備用段落（專案備用庫）：每個頁簽一段（空頁簽也輸出段落標題）
  for (const t of tabs) {
    L.push(tabName(t).startsWith('備用') ? `[${tabName(t)}]` : `[備用：${tabName(t)}]`);
    for (const it of t.items) {
      L.push(row([cleanHead(it.name), placeField(it, it.query), fmtNum(it.stayMin ?? 0), clean(it.note), daysField(it.days)]));
    }
  }
  return L.join('\n') + '\n';
}

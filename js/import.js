// 匯入：貼上文字 → 解析 → 取得地點（座標直接用、地點 ID 直接取得、其他依序搜尋候選）→ 預覽改選 → 建立
// - openImport：專案內「匯入行程」（建立規劃）；可含 [專案]（詢問是否更新專案設定）；備用段落一律合併到專案備用庫
// - openImportProject：首頁「匯入成新專案」（需要 [專案] 段落；備用庫照文字建立）
// - openLibraryImport：專案備用庫編輯畫面的「匯入」（只有備用段落），可「加到現有」或「取代全部」
// 舊格式的 [專案備用庫] 標題仍可讀，底下的段落和其他備用段落一起合併
// 格式說明見 README「匯入／匯出格式」；欄位解析共用 text-format.js
import { lib } from './maps-loader.js';
import {
  state, newDay, makeStop, newLeg, normalizePlan, prevPoint, DEFAULT_STAY, START_AIRPORT_STAY, MODE_LABEL,
} from './state.js';
import { mergeIntoLibrary, buildLibrary, libraryTotal, LIB_TYPE_LABEL } from './library.js';
import { createPlan, updateLibraryTx, createProject, updateProject } from './store.js';
import { typeIcon, LIB_COLORS } from './markers.js';
import { h, openModal, toast, fmtDate, addDays, parseHM, confirmDialog } from './utils.js';
import {
  TYPE_MAP, MODE_MAP, sectionType, parseTabSpec, parsePlaceField, parseDaysField, unescapeNote,
} from './text-format.js';

const QUERY_GAP_MS = 200;
const MAX_CANDIDATES = 5;
const SKIP = '__skip__';
const MAX_DAYS = 30;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const EXAMPLE = `# 只有一行最開頭的「#」是註解
規劃名稱：北海道冬季五日

[Day 1 2/15]
出發 09:15
機場 | ✈ 釧路機場 | 釧路機場 | 45 | |
景點 | 幣舞橋 | 幣舞橋 釧路 | 30 | 開車 |
餐廳 | 和商市場 | 和商市場 | 60 | 步行 | 勝手丼
住宿 | 釧路飯店 | 釧路王子大飯店 | | 開車 | ⚠ 尚未訂房

[Day 2 2/16]
出發 08:30
景點 | 阿寒湖 | 阿寒湖 | 90 | 開車 手動 |
景點 | 摩周湖 | 摩周湖 第一展望台 | 40 | 大眾運輸 手動 90 |

# 備用段落（加到專案備用庫，同名頁簽合併）：顯示名稱 | 搜尋字 | 停留分鐘 | 備註 | 天（空白＝不限）
[備用景點]
細岡展望台 | 細岡展望台 | 40 | | D1
[備用餐廳]
爐端燒 | 炉ばた 釧路 | 90 | ⚠ 需訂位 | D1,D2`;

const LIB_EXAMPLE = `# 只有一行最開頭的「#」是註解；備註以「⚠」開頭表示需確認
# 每個點一行：顯示名稱 | 搜尋字 | 停留分鐘 | 備註 | 天（空白＝不限）
# 段落名稱就是頁簽名稱；沒有的頁簽會新增（含「住宿」＝住宿類、含「餐廳」＝餐廳類、其他＝景點類）
[備用景點]
細岡展望台 | 細岡展望台 | 40 | | D1
摩周湖 | 摩周湖 第一展望台 | 40 | 冬季道路可能封閉 | D2,D3
[備用住宿]
川湯溫泉旅館 | 川湯温泉 御園ホテル | | ⚠ 尚未訂房 |
[備用餐廳]
爐端燒 | 炉ばた 釧路 | 90 | ⚠ 需訂位 |`;

// =====================================================================
// 解析
// =====================================================================
/**
 * 回傳 {
 *   name, tabs:[{name, type}]|null（「備用頁簽」行：備用庫頁簽的順序與類型）,
 *   days: Map<dayIdx, { departTime, charter, points:[] }>,
 *   backups: Map<段落名稱, points[]>（備用庫；舊格式 [專案備用庫] 底下的段落也併在這裡）,
 *   project: null | { name, bounds, boundsQuery, boundsText, startDate, numDays, defaultMode, winterFactor,
 *                     winterFactorsByDay, charterHoursByDay, latestEndTime, startPt, endPt },
 *   errors:[]
 * }
 * libraryOnly：專案備用庫編輯畫面的匯入，只接受備用段落
 */
export function parseImport(text, { libraryOnly = false } = {}) {
  const out = { name: '', tabs: null, days: new Map(), backups: new Map(), project: null, errors: [] };
  let mode = null;        // 'project' | 'day' | 'backup' | 'skip' | null
  let cur = null;          // 目前的 [Day N]
  let curBackup = null;    // 目前的備用段落名稱
  const err = (ln, msg) => out.errors.push(`第 ${ln} 行：${msg}`);

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    const ln = i + 1;
    // 只有一行最開頭（前面只有空白）的「#」才是註解；行尾、欄位中的 # 都是內容
    if (!line || line.startsWith('#')) return;
    let m;

    // ---- 段落標題 ----
    if (/^\[\s*專案\s*\]$/.test(line)) {
      if (libraryOnly) { err(ln, '專案備用庫的匯入不使用 [專案] 段落，這段會略過'); mode = 'skip'; return; }
      out.project ||= {};
      mode = 'project'; cur = null; curBackup = null;
      return;
    }
    // 舊格式：[專案備用庫] 標題只是分隔，底下的備用段落和其他備用段落一起合併
    if (/^\[\s*專案備用庫\s*\]$/.test(line)) { mode = null; cur = null; curBackup = null; return; }
    if ((m = line.match(/^\[\s*Day\s*(\d+)(?:\s+(\d{1,2})\/(\d{1,2}))?\s*\]$/i))) {
      curBackup = null;
      if (libraryOnly) { err(ln, '專案備用庫的匯入只接受 [備用景點] 這類備用段落'); mode = 'skip'; return; }
      const n = +m[1];
      if (n < 1 || n > MAX_DAYS) { err(ln, `Day ${n} 不在 1–${MAX_DAYS} 之間`); mode = 'skip'; return; }
      cur = out.days.get(n - 1) || { departTime: null, charter: null, points: [], line: ln };
      out.days.set(n - 1, cur);
      mode = 'day';
      return;
    }
    if ((m = line.match(/^\[\s*備用\s*[:：]\s*(.+?)\s*\]$/)) || (m = line.match(/^\[\s*(備用[^\]]*?)\s*\]$/))) {
      cur = null;
      const name = m[1].trim();
      if (!out.backups.has(name)) out.backups.set(name, []);
      curBackup = name;
      mode = 'backup';
      return;
    }
    if (/^\[.*\]$/.test(line)) {
      cur = null; curBackup = null; mode = 'skip';
      err(ln, `段落「${line}」無法辨識，這段會略過`);
      return;
    }

    // ---- 規劃名稱、備用頁簽（任何位置） ----
    if (!libraryOnly && (m = line.match(/^規劃名稱\s*[:：]\s*(.*)$/))) { out.name = m[1].trim(); return; }
    if ((m = line.match(/^備用頁簽\s*[:：]\s*(.*)$/))) {
      out.tabs = m[1].split(/[、,，]/).map(x => x.trim()).filter(Boolean).map(parseTabSpec);
      return;
    }

    if (mode === 'skip') return;
    if (mode === 'project') { parseProjectLine(line, ln, out.project, err); return; }

    // ---- 每天的設定 ----
    if ((m = line.match(/^(?:出發|抵達)\s*(\d{1,2}:\d{2})$/))) {
      if (mode !== 'day') { err(ln, '「出發」必須放在 [Day N] 之後'); return; }
      if (parseHM(m[1]) == null) { err(ln, '時間格式錯誤'); return; }
      cur.departTime = m[1].padStart(5, '0');
      return;
    }
    if ((m = line.match(/^包車\s*[:：]\s*(是|否)$/))) {
      if (mode !== 'day') { err(ln, '「包車」必須放在 [Day N] 之後'); return; }
      cur.charter = m[1] === '是';
      return;
    }

    // ---- 地點 ----
    if (line.includes('|')) {
      const f = line.split('|').map(s => s.trim());
      if (mode === 'backup') {
        // 備用段落：顯示名稱 | 搜尋字 | 停留分鐘 | 備註 | 天（第 5 欄可省略；舊格式的第 6 欄「類型」忽略，點的類型跟著頁簽）
        const [display = '', field = '', stayTxt = '', noteTxt = '', daysTxt = ''] = f;
        if (f.length > 6) err(ln, '欄位超過 6 欄，多出的部分忽略（備註中的「|」請改用全形「｜」）');
        if (!display) { err(ln, '缺少顯示名稱'); return; }
        const dd = parseDaysField(daysTxt);
        if (dd.bad.length) err(ln, `天「${dd.bad.join('、')}」無法辨識，已忽略（請寫 D1 或 D1,D3）`);
        out.backups.get(curBackup).push(makePoint({
          kind: 'backup', line: ln, section: curBackup, type: sectionType(curBackup), display: unescapeNote(display),
          field, stay: parseStay(stayTxt, ln, err), note: unescapeNote(noteTxt), days: dd.days,
        }));
        return;
      }
      if (mode !== 'day') {
        err(ln, libraryOnly ? '地點必須放在 [備用景點] 等段落之後' : '地點必須放在 [Day N] 或 [備用景點] 等段落之後');
        return;
      }
      // 行程點：類型 | 顯示名稱 | 搜尋字 | 停留分鐘 | 交通方式 | 備註
      const [typeTxt = '', display = '', field = '', stayTxt = '', modeTxt = '', ...noteParts] = f;
      const type = TYPE_MAP[typeTxt];
      if (!type) { err(ln, `類型「${typeTxt}」無法辨識（機場／景點／餐廳／住宿）`); return; }
      if (!display) { err(ln, '缺少顯示名稱'); return; }
      let legMode = null;
      for (const [k, v] of Object.entries(MODE_MAP)) if (modeTxt.includes(k)) legMode = v;
      if (modeTxt && !legMode && !modeTxt.includes('手動')) err(ln, `交通方式「${modeTxt}」無法辨識，改用專案預設`);
      // 「手動 90」＝直接設定手動時間 90 分；只寫「手動」＝留空等使用者輸入
      const mm = modeTxt.match(/手動\s*(\d+(?:\.\d+)?)/);
      cur.points.push(makePoint({
        kind: 'day', line: ln, type, display: unescapeNote(display), field, stay: parseStay(stayTxt, ln, err),
        mode: legMode, manual: modeTxt.includes('手動'), manualMin: mm ? Number(mm[1]) : null,
        note: unescapeNote(noteParts.join('|').trim()),
      }));
      return;
    }
    err(ln, `無法辨識，已忽略：${line}`);
  });
  // 備用點的類型跟著頁簽（「備用頁簽」行指定的類型優先，否則依段落名稱）
  for (const [section, points] of out.backups) {
    const type = sectionTabType(out, section);
    points.forEach(p => { p.type = type; });
  }
  return out;
}

/** 備用段落對應的頁簽類型 */
const sectionTabType = (parsed, section) => parsed.tabs?.find(t => t.name === section)?.type || sectionType(section);

/** 匯入用的頁簽清單：「備用頁簽」行的順序；沒有列出的段落依出現順序接在後面 */
function tabSpecs(parsed) {
  const specs = [...(parsed.tabs || [])];
  for (const section of parsed.backups.keys()) {
    if (!specs.some(t => t.name === section)) specs.push({ name: section, type: sectionType(section) });
  }
  return specs;
}

/** [專案] 段落的一行 */
function parseProjectLine(line, ln, pj, err) {
  const m = line.match(/^([^:：]+?)\s*[:：]\s*(.*)$/);
  if (!m) { err(ln, `[專案] 段落中無法辨識：${line}`); return; }
  const key = m[1].trim(), v = m[2].trim();
  const list = () => v.split(/[、,，\s]+/).filter(Boolean).map(Number);
  switch (key) {
    case '專案名稱': pj.name = v; break;
    case '地圖範圍': {
      pj.boundsText = v;
      let r;
      if ((r = v.match(/北\s*(-?\d+(?:\.\d+)?)\s*南\s*(-?\d+(?:\.\d+)?)\s*東\s*(-?\d+(?:\.\d+)?)\s*西\s*(-?\d+(?:\.\d+)?)/))) {
        const b = { n: +r[1], s: +r[2], e: +r[3], w: +r[4] };
        if (b.n <= b.s) { err(ln, '地圖範圍的北必須大於南'); return; }
        pj.bounds = b;
      } else if ((r = v.match(/中心\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)\s*縮放\s*(\d+(?:\.\d+)?)/))) {
        pj.bounds = boundsFromCenter(+r[1], +r[2], +r[3]);
      } else if (v) {
        pj.boundsQuery = v;   // 地區名稱：取得地點時再用 Places 搜尋它的範圍
      }
      break;
    }
    case '開始日期':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { err(ln, '開始日期格式請用 YYYY-MM-DD'); return; }
      pj.startDate = v; break;
    case '天數': {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) { err(ln, `天數需在 1–${MAX_DAYS} 之間`); return; }
      pj.numDays = n; break;
    }
    case '預設交通方式':
      if (!MODE_MAP[v]) { err(ln, `交通方式「${v}」無法辨識（開車／大眾運輸／步行／其他）`); return; }
      pj.defaultMode = MODE_MAP[v]; break;
    case '冬季係數':
      if (!(Number(v) > 0)) { err(ln, '冬季係數需大於 0'); return; }
      pj.winterFactor = Number(v); break;
    case '冬季係數每天': {
      const a = list();
      if (!a.length || a.some(x => !(x > 0))) { err(ln, '每天的冬季係數需大於 0，以「、」分隔'); return; }
      pj.winterFactorsByDay = a; break;
    }
    case '每日包車時數': {
      const a = list();
      if (!a.length || a.some(x => !(x >= 0))) { err(ln, '每日包車時數需為數字，以「、」分隔'); return; }
      pj.charterHoursByDay = a; break;
    }
    case '最晚結束時間':
      if (parseHM(v) == null) { err(ln, '最晚結束時間格式請用 HH:MM'); return; }
      pj.latestEndTime = v.padStart(5, '0'); break;
    case '預設起點':
    case '預設終點': {
      const f = v.split('|').map(s => s.trim());
      const [typeTxt = '', display = '', field = ''] = f;
      const type = TYPE_MAP[typeTxt];
      if (!type || !display) { err(ln, `${key}格式：類型 | 顯示名稱 | 搜尋字`); return; }
      pj[key === '預設起點' ? 'startPt' : 'endPt'] = makePoint({ kind: 'proj', role: key, line: ln, type, display, field, stay: null, note: '' });
      break;
    }
    default: err(ln, `[專案] 段落中無法辨識「${key}」，已忽略`);
  }
}

/** 中心＋縮放 → 近似範圍（以 1000×700 像素的畫面估算） */
function boundsFromCenter(lat, lng, zoom) {
  const degPerPx = 360 / (256 * 2 ** zoom);
  const dLng = (1000 / 2) * degPerPx;
  const dLat = (700 / 2) * degPerPx * Math.cos(lat * Math.PI / 180);
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  return { n: r6(lat + dLat), s: r6(lat - dLat), e: r6(lng + dLng), w: r6(lng - dLng) };
}

function parseStay(stayTxt, ln, err) {
  if (stayTxt === '') return null;
  const stay = Number(stayTxt);
  if (isNaN(stay) || stay < 0) { err(ln, `停留分鐘「${stayTxt}」不是數字，改用預設值`); return null; }
  return stay;
}

/**
 * 建立待取得地點的點：
 * - 搜尋字欄位有座標 → 直接使用（status 'fixed'，不呼叫 API）
 * - 只有地點 ID → 之後用 ID 取得
 * - 都沒有 → 用搜尋文字（空白時用顯示名稱）搜尋候選
 */
function makePoint(p) {
  const pf = parsePlaceField(p.field);
  const hasCoord = pf.lat != null && pf.lng != null;
  return {
    ...p,
    note: p.note || '',
    warn: (p.note || '').startsWith('⚠'),
    days: p.days || [],
    placeId: pf.placeId,
    storeQuery: pf.text,                       // 匯入後保留的搜尋文字（專案備用庫）
    query: pf.text || p.display,               // 實際搜尋用
    place: hasCoord ? { placeId: pf.placeId, lat: pf.lat, lng: pf.lng } : null,
    status: hasCoord ? 'fixed' : 'pending',
    via: hasCoord ? 'coord' : pf.placeId ? 'id' : 'search',
    candidates: null, choice: 0,
  };
}

const dayPoints = (parsed) => [...parsed.days.values()].flatMap(d => d.points);
const backupPoints = (parsed) => [...parsed.backups.values()].flat();
const projPoints = (parsed) => [parsed.project?.startPt, parsed.project?.endPt].filter(Boolean);
const allPoints = (parsed) => [...projPoints(parsed), ...dayPoints(parsed), ...backupPoints(parsed)];
const isChosen = (p) => p.status === 'fixed' || (p.choice !== SKIP && !!p.candidates?.[p.choice]);
const isMissing = (p) => p.status === 'none' || p.status === 'error';

/** 超出天數的 [Day] 段落（會略過） */
function dayRangeErrors(parsed, numDays) {
  return [...parsed.days.entries()].filter(([di]) => di >= numDays)
    .map(([di, d]) => `第 ${d.line} 行：Day ${di + 1} 超出專案天數（${numDays} 天），這天會略過`);
}

// =====================================================================
// 取得地點
// =====================================================================
/**
 * 依序處理（每次呼叫 API 間隔 200ms）：
 * 座標＝直接使用；地點 ID＝fetchFields 取得位置（失敗時有搜尋文字就改用搜尋）；其他＝搜尋候選
 */
async function queryCandidates(points, bounds, onProgress, isCancelled) {
  const { Place, AutocompleteSuggestion, AutocompleteSessionToken } = await lib('places');
  let calls = 0;
  const gap = async () => { if (calls++ > 0) await sleep(QUERY_GAP_MS); };
  for (let i = 0; i < points.length; i++) {
    if (isCancelled()) return;
    const p = points[i];
    if (p.status === 'fixed') { onProgress(i + 1, points.length); continue; }
    if (p.via === 'id') {
      await gap();
      try {
        const place = new Place({ id: p.placeId });
        await place.fetchFields({ fields: ['location'] });   // Essentials
        p.place = { placeId: p.placeId, lat: place.location.lat(), lng: place.location.lng() };
        p.status = 'fixed';
        onProgress(i + 1, points.length);
        continue;
      } catch (e) {
        console.warn('地點 ID 取得失敗', p.placeId, e);
        if (!p.storeQuery) { p.status = 'error'; p.candidates = []; p.choice = SKIP; onProgress(i + 1, points.length); continue; }
        p.via = 'search';   // 改用搜尋文字
      }
    }
    await gap();
    try {
      p.token = new AutocompleteSessionToken();   // 每個點一個 session；選定後 fetchFields 結束 session
      const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input: p.query,
        locationRestriction: { north: bounds.n, south: bounds.s, east: bounds.e, west: bounds.w },
        language: 'zh-TW',
        sessionToken: p.token,
      });
      p.candidates = (suggestions || []).map(s => s.placePrediction).filter(Boolean).slice(0, MAX_CANDIDATES);
      p.status = p.candidates.length ? 'ok' : 'none';
      p.choice = p.candidates.length ? 0 : SKIP;
    } catch (e) {
      console.warn('候選查詢失敗', p.query, e);
      p.candidates = []; p.status = 'error'; p.choice = SKIP;
    }
    onProgress(i + 1, points.length);
  }
}

/** 對搜尋選定的候選 fetchFields（id、location），依序進行；結果放在 p.place */
async function resolvePoints(points, onProgress = () => {}) {
  const todo = points.filter(p => p.status !== 'fixed' && isChosen(p));
  for (let i = 0; i < todo.length; i++) {
    const p = todo[i];
    const place = p.candidates[p.choice].toPlace();
    await place.fetchFields({ fields: ['id', 'location'] });
    p.place = { placeId: place.id, lat: place.location.lat(), lng: place.location.lng() };
    onProgress(i + 1, todo.length);
    if (i < todo.length - 1) await sleep(QUERY_GAP_MS);
  }
  points.forEach(p => { if (!isChosen(p)) p.place = null; });
}

/** [專案] 的地圖範圍寫成地區名稱時：搜尋該地區，取它的範圍（viewport，Essentials） */
async function resolveProjectBounds(pj) {
  if (!pj || pj.bounds || !pj.boundsQuery) return;
  const { AutocompleteSuggestion } = await lib('places');
  const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({ input: pj.boundsQuery, language: 'zh-TW' });
  const pred = suggestions?.[0]?.placePrediction;
  if (!pred) throw new Error(`找不到地區「${pj.boundsQuery}」，請改寫成「北 … 南 … 東 … 西 …」`);
  const place = pred.toPlace();
  await place.fetchFields({ fields: ['id', 'location', 'viewport'] });
  const v = place.viewport?.toJSON();
  if (!v) throw new Error(`地區「${pj.boundsQuery}」沒有範圍資訊，請改寫成「北 … 南 … 東 … 西 …」`);
  pj.bounds = { n: v.north, s: v.south, e: v.east, w: v.west };
}

// =====================================================================
// 建立
// =====================================================================
const pointPt = (p) => ({ name: p.display, ...p.place, type: p.type });

/**
 * [專案] → 專案設定（建立新專案：base＝{}；更新目前專案：base＝目前設定，文字中沒寫的項目維持原值）
 * 不含專案名稱
 */
function buildProjectData(pj, base = {}) {
  const numDays = pj.numDays ?? base.numDays;
  const winter = pj.winterFactor ?? base.winterFactor ?? 1;
  const fill = (arr, def) => Array.from({ length: numDays }, (_, i) => arr?.[i] ?? arr?.[arr.length - 1] ?? def);
  // 冬季係數：有「冬季係數每天」＝每天個別設定；只寫「冬季係數」＝統一數值；都沒寫＝維持原設定
  let winterPerDay, winterFactorsByDay;
  if (pj.winterFactorsByDay) { winterPerDay = true; winterFactorsByDay = fill(pj.winterFactorsByDay, winter); }
  else if (pj.winterFactor != null) { winterPerDay = false; winterFactorsByDay = null; }
  else { winterPerDay = !!base.winterPerDay; winterFactorsByDay = base.winterFactorsByDay ? fill(base.winterFactorsByDay, winter) : null; }
  const data = {
    startDate: pj.startDate ?? base.startDate,
    numDays,
    defaultMode: pj.defaultMode ?? base.defaultMode ?? 'drive',
    winterFactor: winter,
    winterPerDay,
    winterFactorsByDay,
    charterHoursByDay: fill(pj.charterHoursByDay ?? base.charterHoursByDay, base.defaultCharterHours ?? 10),
    defaultCharterHours: base.defaultCharterHours ?? 10,
    latestEndTime: pj.latestEndTime ?? base.latestEndTime ?? '20:00',
    defaultStart: pj.startPt?.place ? pointPt(pj.startPt) : (base.defaultStart ?? null),
    defaultEnd: pj.endPt?.place ? pointPt(pj.endPt) : (base.defaultEnd ?? null),
  };
  const bounds = pj.bounds ?? base.bounds;
  if (bounds) data.bounds = bounds;
  return data;
}

/** 新專案需要的欄位 */
function projectMissing(pj) {
  if (!pj) return ['文字中沒有 [專案] 段落'];
  const miss = [];
  if (!pj.name) miss.push('專案名稱');
  if (!pj.bounds && !pj.boundsQuery) miss.push('地圖範圍');
  if (!pj.startDate) miss.push('開始日期');
  if (!pj.numDays) miss.push('天數');
  return miss.length ? [`[專案] 缺少：${miss.join('、')}`] : [];
}

/** points 已 resolve；只建立行程（備用庫是專案層級，另外合併） */
function buildPlan(parsed, project) {
  const days = Array.from({ length: project.numDays }, (_, i) => newDay(project, i));
  const manualFor = new Map();   // stop id → 匯入指定的手動分鐘
  let firstSrc = null;
  for (const [di, d] of [...parsed.days.entries()].sort((a, b) => a[0] - b[0])) {
    if (di >= project.numDays) continue;   // 超出天數（預覽已提示）
    if (d.departTime) days[di].departTime = d.departTime;
    if (d.charter != null) days[di].charter = d.charter;
    for (const p of d.points) {
      if (!p.place) continue;
      const stop = makeStop({ ...pointPt(p), stayMin: p.stay ?? DEFAULT_STAY[p.type], note: p.note });
      if (p.mode || p.manual) {
        stop.leg = newLeg(p.mode || project.defaultMode || 'drive');
        if (p.manual && p.manualMin == null) stop.leg.needManual = true;
      }
      days[di].stops.push(stop);
      firstSrc ||= p;
      if (p.manualMin != null) manualFor.set(stop.id, p.manualMin);
    }
  }
  // 行程第一點若為機場：停留時間寫入起點停留時間（未填則 45 分）
  const first = days.flatMap(d => d.stops)[0];
  if (first && first.type === 'airport') {
    first.stayMin = firstSrc?.stay ?? START_AIRPORT_STAY;
    first.startStayInit = true;
  }
  const plan = { days };
  normalizePlan(plan, project);
  // 手動時間：同時記下起訖座標（與在畫面上按 ✏️ 設定相同，之後地點變更會提示確認）
  plan.days.forEach((d, di) => d.stops.forEach((s, i) => {
    const min = manualFor.get(s.id);
    const from = prevPoint(plan, di, i);
    if (min == null || !s.leg || !from) return;   // 行程第一點沒有前一段，忽略
    Object.assign(s.leg, {
      manualMin: min, manualFrom: { lat: from.lat, lng: from.lng }, manualTo: { lat: s.lat, lng: s.lng },
    });
  }));
  return plan;
}

/** 備用點 → 備用庫的 [{ tabName, tabType, pt }]（依段落名稱放入同名頁簽） */
const libEntries = (parsed) => backupPoints(parsed).filter(p => p.place).map(p => ({
  tabName: p.section, tabType: sectionTabType(parsed, p.section),
  pt: { ...pointPt(p), stayMin: p.stay ?? undefined, note: p.note, days: p.days, query: p.storeQuery || undefined },
}));

// =====================================================================
// 預覽
// =====================================================================
function pickCell(p) {
  if (p.status === 'fixed') return h('span', { class: 'ok-text' }, p.via === 'id' ? '✓ 依地點 ID 取得' : '✓ 直接使用座標');
  if (p.status === 'pending') return h('span', { class: 'muted' }, '查詢中…');
  if (!p.candidates?.length) return h('span', {}, h('span', { class: 'warn' }, p.status === 'error' ? '查詢失敗，' : '查無候選，'), '將略過此點');
  const opts = p.candidates.map((c, i) => h('option', { value: i },
    `${c.mainText?.text || c.text?.text || ''}${c.secondaryText?.text ? ' — ' + c.secondaryText.text : ''}`));
  opts.push(h('option', { value: SKIP }, '略過此點'));
  const sel = h('select', { class: 'ip-pick', onChange: (e) => {
    p.choice = e.target.value === SKIP ? SKIP : +e.target.value;
    p.onChoice?.();
  } }, opts);
  sel.value = String(p.choice);
  return sel;
}

const daysText = (p) => (p.days?.length ? p.days.map(d => 'D' + d).join(',') : '不限');

function pointRow(p, color, extra, { dim = false } = {}) {
  const flag = p.warn || isMissing(p);
  return h('div', { class: 'ip-row' + (flag ? ' ip-flag' : '') + (dim ? ' ip-dim' : '') },
    typeIcon(p.type, color),
    h('div', { class: 'ip-name' }, h('strong', {}, p.display),
      h('div', { class: 'small muted' }, p.via === 'search' ? `搜尋：${p.query}` : p.storeQuery ? `搜尋字：${p.storeQuery}` : ''),
      p.note ? h('div', { class: 'small pre' + (p.warn ? ' warn' : ' muted') }, p.note) : null),
    h('div', { class: 'ip-pickcell' }, pickCell(p)),
    h('div', { class: 'small' }, p.type === 'hotel' ? '住宿' : `${p.stay ?? DEFAULT_STAY[p.type]} 分`),
    h('div', { class: 'small' }, extra));
}

function dayRows(parsed, project, numDays) {
  const rows = [];
  for (const [di, d] of [...parsed.days.entries()].sort((a, b) => a[0] - b[0])) {
    const skipped = di >= numDays;
    const date = !skipped && project?.startDate ? fmtDate(addDays(project.startDate, di)) : '';
    rows.push(h('div', { class: 'ip-day' }, `Day ${di + 1}  ${date}${d.departTime ? `　出發 ${d.departTime}` : ''}${d.charter === false ? '　不包車' : ''}`,
      skipped ? h('span', { class: 'warn' }, `　超出專案天數，這天會略過`) : null));
    for (const p of d.points) {
      rows.push(pointRow(p, '#666', `${p.mode ? MODE_LABEL[p.mode] : '預設'}${p.manualMin != null ? `・手動 ${p.manualMin} 分` : p.manual ? '・手動' : ''}`, { dim: skipped }));
    }
  }
  return rows;
}

/** 備用段落的預覽列（顏色依頁簽類型） */
function backupRows(parsed) {
  const rows = [];
  for (const [section, points] of parsed.backups) {
    const type = sectionTabType(parsed, section);
    rows.push(h('div', { class: 'ip-day' }, `備用庫［${section}］`, h('span', { class: 'muted small' }, `　${LIB_TYPE_LABEL[type]}頁簽`)));
    for (const p of points) rows.push(pointRow(p, LIB_COLORS[type], `天：${daysText(p)}`));
  }
  return rows;
}

/** 摘要：會匯入幾筆、哪些搜尋不到 */
function summaryNodes(points) {
  if (points.some(p => p.status === 'pending')) return [];
  const chosen = points.filter(isChosen).length;
  const missing = points.filter(isMissing);
  const skipped = points.length - chosen - missing.length;
  return [
    h('div', {}, h('strong', {}, `將匯入 ${chosen} 個地點`), skipped > 0 ? `（手動略過 ${skipped} 個）` : ''),
    missing.length ? h('div', { class: 'warn' }, `搜尋不到 ${missing.length} 個：${missing.map(p => p.display).join('、')}`) : null,
  ];
}

/** [專案] 設定摘要 */
function projectSummary(pj) {
  const rows = [
    ['專案名稱', pj.name],
    ['地圖範圍', pj.bounds ? `北 ${pj.bounds.n} 南 ${pj.bounds.s} 東 ${pj.bounds.e} 西 ${pj.bounds.w}` : pj.boundsQuery ? `搜尋地區「${pj.boundsQuery}」` : ''],
    ['開始日期', pj.startDate], ['天數', pj.numDays],
    ['預設交通方式', pj.defaultMode ? MODE_LABEL[pj.defaultMode] : ''],
    ['冬季係數', pj.winterFactorsByDay ? `每天：${pj.winterFactorsByDay.join('、')}` : pj.winterFactor],
    ['每日包車時數', pj.charterHoursByDay?.join('、')],
    ['最晚結束時間', pj.latestEndTime],
    ['預設起點', pj.startPt?.display], ['預設終點', pj.endPt?.display],
  ].filter(([, v]) => v != null && v !== '');
  return h('div', { class: 'ip-project' }, h('strong', {}, '[專案] 設定'),
    h('div', { class: 'ip-grid small' }, rows.map(([k, v]) => [h('span', { class: 'muted' }, k), h('span', {}, String(v))])));
}

/** 各天點數摘要 */
function countsLine(parsed, numDays) {
  const parts = [...parsed.days.entries()].sort((a, b) => a[0] - b[0])
    .map(([di, d]) => `D${di + 1} ${d.points.length} 點${di >= numDays ? '（略過）' : ''}`);
  const bk = backupPoints(parsed).length;
  return h('div', { class: 'small' }, [parts.length ? '行程：' + parts.join('・') : '行程：無',
    bk ? `備用庫 ${bk} 點（${parsed.backups.size} 個頁簽）` : null].filter(Boolean).join('　'));
}

/** 共用：對話框中的「解析 → 取得地點 → 預覽」流程 */
function importFlow({ title, example, help, parse, onPreview }) {
  const ta = h('textarea', { class: 'import-text', placeholder: example, spellcheck: 'false' });
  const body = h('div', { class: 'import' });
  const m = openModal({ title, body, wide: true, actions: [] });
  // 關閉對話框或按「返回修改」時，停止尚未完成的查詢
  let closed = false;
  let runId = 0;
  m.result.then(() => { closed = true; });

  function showInput() {
    body.replaceChildren(
      h('div', { class: 'small muted pre' }, help),
      ta,
      h('div', { class: 'row end' },
        h('button', { onClick: () => { ta.value = example; } }, '填入範例'),
        h('button', { onClick: () => m.close() }, '取消'),
        h('button', { class: 'primary', onClick: start }, '解析並取得地點')));
  }
  function start() {
    const parsed = parse(ta.value);
    if (!parsed) return;
    const myRun = ++runId;
    onPreview(parsed, {
      body, modal: m,
      cancelled: () => closed || myRun !== runId,
      back: () => { runId++; showInput(); },
    });
  }
  showInput();
  setTimeout(() => ta.focus(), 30);
  return m;
}

const HELP_PLAN =
  '每天：「[Day N M/D]」、「出發 HH:MM」，每個點一行：類型 | 顯示名稱 | 搜尋字 | 停留分鐘 | 交通方式 | 備註。\n' +
  '交通方式可加「手動」（之後再輸入時間）或「手動 90」（直接設定手動時間 90 分）。\n' +
  '備用點：[備用景點] 等段落（加到專案備用庫，同名頁簽合併、重複略過），每行：顯示名稱 | 搜尋字 | 停留分鐘 | 備註 | 天（例如 D1,D3；空白＝不限）。\n' +
  '搜尋字可寫「id:地點ID@緯度,經度」直接指定地點（匯出的「匯入格式」就是這樣）。只有一行最開頭的「#」是註解。';

// =====================================================================
// 專案內「匯入行程」
// =====================================================================
/** onDone：沒有建立規劃（只合併到備用庫或只更新專案設定）時呼叫，例如重新整理分支圖 */
export function openImport(project, { onDone } = {}) {
  importFlow({
    title: '匯入行程', example: EXAMPLE, help: HELP_PLAN,
    parse: (text) => {
      const parsed = parseImport(text);
      if (!allPoints(parsed).length && !parsed.project && !parsed.backups.size) { toast('沒有找到任何地點，請確認格式', 'warn'); return null; }
      return parsed;
    },
    onPreview: async (parsed, { body, modal, cancelled, back }) => {
      let updateProj = false;
      const pj = parsed.project;
      const points = allPoints(parsed);
      const hasDays = dayPoints(parsed).length > 0;
      const hasBackups = parsed.backups.size > 0 || !!parsed.tabs?.length;
      const numDays = () => (updateProj && pj?.numDays ? pj.numDays : project.numDays);

      const progress = h('div', { class: 'muted' }, `取得地點中… 0 / ${points.length}`);
      const table = h('div', { class: 'import-preview scroll' });
      const summary = h('div', { class: 'import-summary' });
      const errorsBox = h('div', { class: 'import-errors' });
      const counts = h('div');
      const createBtn = h('button', { class: 'primary', disabled: true, onClick: () => create(createBtn) });
      const nameIn = h('input', { type: 'text', class: 'full', value: parsed.name || '匯入的規劃' });
      nameIn.addEventListener('input', () => { parsed.name = nameIn.value.trim(); });
      const nameRow = h('label', { class: 'row' }, '規劃名稱', nameIn);
      const projRow = pj ? h('div', { class: 'ip-project-box' },
        projectSummary(pj),
        h('label', { class: 'row' },
          h('input', { type: 'checkbox', onChange: (e) => { updateProj = e.target.checked; refresh(); } }),
          '用文字中的 [專案] 設定更新目前專案（不含專案名稱）')) : null;
      const libNote = hasBackups ? h('div', { class: 'small muted' }, '備用段落會合併到這個專案的備用庫（所有規劃共用）：同名頁簽合併、沒有的頁簽新增、重複地點略過。') : null;

      const refresh = () => {
        nameRow.classList.toggle('hidden', !hasDays);
        createBtn.textContent = hasDays ? (hasBackups ? '建立規劃並合併備用庫' : '建立規劃')
          : hasBackups ? '合併到備用庫' : '套用專案設定';
        const errs = [...parsed.errors, ...dayRangeErrors(parsed, numDays())];
        errorsBox.replaceChildren(...errs.map(e => h('div', {}, '⚠ ' + e)));
        errorsBox.classList.toggle('hidden', !errs.length);
        counts.replaceChildren(countsLine(parsed, numDays()));
        table.replaceChildren(...dayRows(parsed, project, numDays()), ...backupRows(parsed));
        summary.replaceChildren(...summaryNodes(points.filter(p => p.kind !== 'proj' || updateProj)));
      };
      points.forEach(p => { p.onChoice = refresh; });
      body.replaceChildren(...[nameRow, projRow, errorsBox, libNote, counts, progress, table, summary,
        h('div', { class: 'row end' }, h('button', { onClick: back }, '返回修改'), createBtn)].filter(Boolean));
      refresh();
      try {
        await queryCandidates(points, project.bounds, (done, all) => {
          if (cancelled()) return;
          progress.textContent = done < all ? `取得地點中… ${done} / ${all}` : `完成，共 ${all} 個地點。黃色列請確認。`;
          refresh();
        }, cancelled);
      } catch (e) {
        progress.textContent = '地點查詢失敗：' + e.message;
        return;
      }
      if (!cancelled()) createBtn.disabled = false;

      async function create(btn) {
        const label = btn.textContent;
        btn.disabled = true; btn.textContent = '建立中…';
        try {
          await resolvePoints(points, (i, n) => { btn.textContent = `取得地點資料… ${i} / ${n}`; });
          // 先更新專案設定（勾選時），規劃的天數與日期依更新後的設定
          if (updateProj && pj) {
            btn.textContent = '更新專案設定…';
            await resolveProjectBounds(pj);
            const data = buildProjectData(pj, project);
            await updateProject(project.id, data);
            Object.assign(project, data);
            if (state.project?.id === project.id) Object.assign(state.project, data);
          }
          let planId = null;
          if (hasDays) {
            const plan = buildPlan(parsed, project);
            planId = await createPlan(project.id, { name: parsed.name || '匯入的規劃', ...plan });
          }
          let libMsg = '';
          if (hasBackups) {
            const entries = libEntries(parsed);
            const r = await updateLibraryTx(project.id, (l) => mergeIntoLibrary(l, entries, { tabSpecs: tabSpecs(parsed) }));
            libMsg = `備用庫新增 ${r.added} 筆${r.dup ? `，略過重複 ${r.dup} 筆` : ''}${r.newTabs ? `，新增 ${r.newTabs} 個頁簽` : ''}`;
          }
          modal.close(null);
          if (planId) {
            toast(`已建立規劃${updateProj ? '、已更新專案設定' : ''}${libMsg ? '；' + libMsg : ''}`, 'ok', 5000);
            location.hash = `#/p/${project.id}/${planId}`;   // 開啟後自動觸發路線計算
          } else {
            toast([updateProj ? '已更新專案設定' : '', libMsg].filter(Boolean).join('；') || '沒有可匯入的內容', 'ok', 5000);
            onDone?.();
          }
        } catch (e) {
          console.error(e);
          toast('建立失敗：' + e.message, 'error', 6000);
          btn.disabled = false; btn.textContent = label;
        }
      }
    },
  });
}

// =====================================================================
// 首頁「匯入成新專案」
// =====================================================================
export function openImportProject() {
  importFlow({
    title: '匯入成新專案',
    example: '# 請貼上「匯出 → 匯出成匯入格式」的文字；需要 [專案] 段落\n[專案]\n專案名稱：北海道冬季\n地圖範圍：北海道\n開始日期：2027-02-15\n天數：3\n\n' + EXAMPLE.replace(/^# .*\n/, ''),
    help: '需要 [專案] 段落（專案名稱、地圖範圍、開始日期、天數為必填）。其餘格式與「匯入行程」相同；備用庫照文字建立（頁簽順序、類型都照「備用頁簽」行）。\n' + HELP_PLAN,
    parse: (text) => {
      const parsed = parseImport(text);
      if (!parsed.project) { toast('文字中沒有 [專案] 段落', 'warn'); return null; }
      return parsed;
    },
    onPreview: async (parsed, { body, modal, cancelled, back }) => {
      const pj = parsed.project;
      const points = allPoints(parsed);
      const missingFields = projectMissing(pj);
      const progress = h('div', { class: 'muted' }, '準備中…');
      const table = h('div', { class: 'import-preview scroll' });
      const summary = h('div', { class: 'import-summary' });
      const createBtn = h('button', { class: 'primary', disabled: true, onClick: () => create(createBtn) }, '建立新專案');
      const projNameIn = h('input', { type: 'text', class: 'full', value: pj.name || '' });
      const planNameIn = h('input', { type: 'text', class: 'full', value: parsed.name || '匯入的規劃' });
      const numDays = pj.numDays || 0;
      const errs = [...missingFields, ...parsed.errors, ...dayRangeErrors(parsed, numDays)];
      const refresh = () => {
        table.replaceChildren(...dayRows(parsed, pj, numDays), ...backupRows(parsed));
        summary.replaceChildren(...summaryNodes(points));
      };
      points.forEach(p => { p.onChoice = refresh; });
      body.replaceChildren(...[
        h('label', { class: 'row' }, '專案名稱', projNameIn),
        h('label', { class: 'row' }, '規劃名稱', planNameIn),
        errs.length ? h('div', { class: 'import-errors' }, errs.map(e => h('div', {}, '⚠ ' + e))) : null,
        projectSummary(pj), countsLine(parsed, numDays),
        progress, table, summary,
        h('div', { class: 'small muted' }, '新專案的擁有帳號是目前登入的帳號。'),
        h('div', { class: 'row end' }, h('button', { onClick: back }, '返回修改'), createBtn),
      ].filter(Boolean));
      refresh();
      if (missingFields.length) { progress.textContent = '請補上 [專案] 的必填欄位後再試。'; return; }
      try {
        // 地圖範圍寫成地區名稱：先取得範圍，搜尋地點時才能限制在範圍內
        if (!pj.bounds) { progress.textContent = `取得地區「${pj.boundsQuery}」的範圍…`; await resolveProjectBounds(pj); refresh(); }
        await queryCandidates(points, pj.bounds, (done, all) => {
          if (cancelled()) return;
          progress.textContent = done < all ? `取得地點中… ${done} / ${all}` : `完成，共 ${all} 個地點。黃色列請確認。`;
          refresh();
        }, cancelled);
      } catch (e) {
        progress.textContent = '取得地點失敗：' + e.message;
        return;
      }
      if (!cancelled()) createBtn.disabled = false;

      async function create(btn) {
        const name = projNameIn.value.trim();
        if (!name) { toast('請輸入專案名稱', 'warn'); return; }
        btn.disabled = true; btn.textContent = '建立中…';
        let pid = null;
        try {
          await resolvePoints(points, (i, n) => { btn.textContent = `取得地點資料… ${i} / ${n}`; });
          const data = { name, ...buildProjectData(pj), creatorNickname: state.nickname };
          // 先建立專案（擁有帳號＝目前帳號），完成後才寫入規劃與備用庫
          btn.textContent = '建立專案…';
          pid = await createProject(data);
          const project = { id: pid, ...data };
          btn.textContent = '建立規劃…';
          const plan = buildPlan(parsed, project);
          const planId = await createPlan(pid, { name: planNameIn.value.trim() || '匯入的規劃', ...plan });
          // 備用庫照文字建立：頁簽順序、類型、空頁簽都照文字；文字中沒有任何頁簽時用預設三個
          btn.textContent = '建立備用庫…';
          const built = buildLibrary(tabSpecs(parsed), libEntries(parsed));
          await updateLibraryTx(pid, (l) => { l.tabs = built.lib.tabs; return built; });
          modal.close(null);
          toast(`已建立專案「${name}」`, 'ok', 5000);
          location.hash = `#/p/${pid}/${planId}`;
        } catch (e) {
          console.error(e);
          toast('建立失敗：' + e.message + (pid ? '（已建立的專案不完整，可在首頁的專案設定刪除後重試）' : ''), 'error', 8000);
          btn.disabled = false; btn.textContent = '建立新專案';
        }
      }
    },
  });
}

// =====================================================================
// 專案備用庫的匯入（編輯畫面）
// =====================================================================
/**
 * getLibrary()：目前的備用庫（用來估計重複與取代筆數）
 * apply(entries, mode, tabSpecs)：寫入（mode 'append'＝加到現有、'replace'＝取代全部），回傳 { added, dup, newTabs }
 */
export function openLibraryImport(project, { getLibrary, apply }) {
  importFlow({
    title: '匯入專案備用庫', example: LIB_EXAMPLE,
    help: '段落：[備用景點]、[備用住宿]、[備用餐廳] 或任何 [備用XXX]／[備用：名稱]（段落名稱＝頁簽名稱，沒有的頁簽會新增）。\n' +
      '每個點一行：顯示名稱 | 搜尋字 | 停留分鐘 | 備註 | 天；天可寫 D1 或 D1,D3，空白＝不限（舊格式只有 4 欄也可以）。\n' +
      '只有一行最開頭的「#」是註解；備註以「⚠」開頭表示需確認（預覽中以黃色標示）。',
    parse: (text) => {
      const parsed = parseImport(text, { libraryOnly: true });
      if (!backupPoints(parsed).length) { toast('沒有找到任何地點，請確認格式', 'warn'); return null; }
      return parsed;
    },
    onPreview: async (parsed, { body, modal, cancelled, back }) => {
      const points = backupPoints(parsed);
      let mode = 'append';
      const progress = h('div', { class: 'muted' }, `取得地點中… 0 / ${points.length}`);
      const table = h('div', { class: 'import-preview scroll' });
      const summary = h('div', { class: 'import-summary' });
      const goBtn = h('button', { class: 'primary', disabled: true, onClick: () => go(goBtn) }, '匯入');
      const radio = (v, label) => h('label', { class: 'row' },
        h('input', { type: 'radio', name: 'lib-mode', value: v, checked: mode === v, onChange: () => { mode = v; refresh(); } }), label);
      const refresh = () => {
        table.replaceChildren(...backupRows(parsed));
        const nodes = summaryNodes(points);
        if (nodes.length) {
          const cur = getLibrary();
          const total = libraryTotal(cur);
          const byTab = [...parsed.backups.entries()].map(([sec, pts]) => `${sec} ${pts.filter(isChosen).length}`).join('・');
          nodes.splice(1, 0, h('div', { class: 'small muted' }, byTab));
          const newTabs = tabSpecs(parsed).filter(t => !cur.tabs.some(x => x.name === t.name)).map(t => t.name);
          if (newTabs.length) nodes.push(h('div', { class: 'small muted' }, `會新增頁簽：${newTabs.join('、')}`));
          if (mode === 'append') {
            // 依地點 ID 估計與現有重複的筆數（實際以匯入時為準）
            const ids = new Set(cur.tabs.flatMap(t => t.items.map(i => i.placeId)).filter(Boolean));
            const dup = points.filter(p => isChosen(p) && ids.has(p.place?.placeId || p.candidates?.[p.choice]?.placeId)).length;
            if (dup) nodes.push(h('div', { class: 'small muted' }, `其中約 ${dup} 筆與現有地點重複，會略過`));
          } else if (total) {
            nodes.push(h('div', { class: 'warn' }, `取代全部：會先刪除備用庫現有的 ${total} 個點（頁簽保留）`));
          }
        }
        summary.replaceChildren(...nodes);
      };
      points.forEach(p => { p.onChoice = refresh; });
      body.replaceChildren(...[
        parsed.errors.length ? h('div', { class: 'import-errors' }, parsed.errors.map(e => h('div', {}, '⚠ ' + e))) : null,
        progress, table, summary,
        h('div', { class: 'row ip-target' }, h('strong', {}, '匯入方式：'), radio('append', '加到現有（重複的略過）'), radio('replace', '取代全部')),
        h('div', { class: 'row end' }, h('button', { onClick: back }, '返回修改'), goBtn),
      ].filter(Boolean));
      refresh();
      try {
        await queryCandidates(points, project.bounds, (done, all) => {
          if (cancelled()) return;
          progress.textContent = done < all ? `取得地點中… ${done} / ${all}` : `完成，共 ${all} 個地點。黃色列請確認。`;
          refresh();
        }, cancelled);
      } catch (e) {
        progress.textContent = '地點查詢失敗：' + e.message;
        return;
      }
      if (!cancelled()) goBtn.disabled = false;

      async function go(btn) {
        if (!points.some(isChosen)) { toast('沒有可匯入的地點', 'warn'); return; }
        if (mode === 'replace') {
          const total = libraryTotal(getLibrary());
          if (total && !(await confirmDialog(`取代全部會刪除備用庫現有的 ${total} 個點（頁簽保留），改成這次匯入的內容。\n這個專案的所有規劃共用備用庫。確定取代？`, '取代全部', true))) return;
        }
        btn.disabled = true; btn.textContent = '匯入中…';
        try {
          await resolvePoints(points, (i, n) => { btn.textContent = `取得地點資料… ${i} / ${n}`; });
          const r = apply(libEntries(parsed), mode, tabSpecs(parsed));
          modal.close(null);
          toast(`已${mode === 'replace' ? '取代為' : '新增'} ${r.added} 筆${r.dup ? `，略過重複 ${r.dup} 筆` : ''}${r.newTabs ? `，新增 ${r.newTabs} 個頁簽` : ''}`, 'ok', 5000);
        } catch (e) {
          console.error(e);
          toast('匯入失敗：' + e.message, 'error', 6000);
          btn.disabled = false; btn.textContent = '匯入';
        }
      }
    },
  });
}

// 匯入：貼上文字 → 解析 → 依序以 AutocompleteSuggestion 查候選 → 預覽改選 → 建立
// - openImport：匯入行程（建立規劃）；可含 [備用景點] 等段落，放到「本規劃備用庫」或「專案備用庫」
// - openLibraryImport：專案備用庫編輯畫面的「匯入」（只有備用段落），可「加到現有」或「取代全部」
import { lib } from './maps-loader.js';
import {
  newDay, makeStop, newLeg, normalizePlan, prevPoint, defaultTabs, makeBackupItem, DEFAULT_STAY, START_AIRPORT_STAY,
  HOTEL_TAB_KIND, MODE_LABEL,
} from './state.js';
import { LIB_TABS, LIB_SECTION, mergeIntoLibrary, libraryCounts } from './library.js';
import { createPlan, updateLibraryTx } from './store.js';
import { typeIcon, LIB_COLORS } from './markers.js';
import { h, openModal, toast, uid, fmtDate, addDays, parseHM, confirmDialog } from './utils.js';

const QUERY_GAP_MS = 200;
const MAX_CANDIDATES = 5;
const TYPE_MAP = { 機場: 'airport', 景點: 'spot', 餐廳: 'food', 住宿: 'hotel' };
const MODE_MAP = { 開車: 'drive', 大眾運輸: 'transit', 步行: 'walk', 其他: 'other' };
const SKIP = '__skip__';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const EXAMPLE = `# 「#」開頭的行是註解
規劃名稱：北海道冬季五日
備用頁簽：備用景點、備用住宿、雨天備案

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

# 備用段落：顯示名稱 | 搜尋字 | 停留分鐘 | 備註
[備用景點]
細岡展望台 | 細岡展望台 | 40 |
[備用餐廳]
爐端燒 | 炉ばた 釧路 | 90 | ⚠ 需訂位`;

const LIB_EXAMPLE = `# 「#」開頭的行是註解；備註以「⚠」開頭表示需確認
# 每個點一行：顯示名稱 | 搜尋字 | 停留分鐘 | 備註
[備用景點]
細岡展望台 | 細岡展望台 | 40 |
摩周湖 | 摩周湖 第一展望台 | 40 | 冬季道路可能封閉
[備用住宿]
川湯溫泉旅館 | 川湯温泉 御園ホテル | | ⚠ 尚未訂房
[備用餐廳]
爐端燒 | 炉ばた 釧路 | 90 | ⚠ 需訂位`;

/** 備用段落名稱 → 類型（含「住宿」＝住宿、含「餐廳」＝餐廳、其他＝景點） */
const sectionType = (name) => (name.includes('住宿') ? 'hotel' : name.includes('餐廳') ? 'food' : 'spot');

// ---------- 解析 ----------
/**
 * 回傳 { name, tabs:[名稱], days: Map<dayIdx, { departTime, points:[] }>, backups: Map<段落名稱, points[]>, errors:[] }
 * 行程點 point: { kind:'day', line, type, display, query, stay, mode, manual, manualMin, note, warn }
 * 備用點 point: { kind:'backup', line, section, type, display, query, stay, note, warn }
 * libraryOnly：只接受三個專案備用庫段落（專案備用庫編輯畫面的匯入）
 */
export function parseImport(text, project, { libraryOnly = false } = {}) {
  const out = { name: '', tabs: null, days: new Map(), backups: new Map(), errors: [] };
  let cur = null;        // 目前的 [Day N]
  let curBackup = null;  // 目前的 [備用XXX]
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    const ln = i + 1;
    if (!line || line.startsWith('#')) return;
    let m;
    if (!libraryOnly && (m = line.match(/^規劃名稱\s*[:：]\s*(.+)$/))) { out.name = m[1].trim(); return; }
    if (!libraryOnly && (m = line.match(/^備用頁簽\s*[:：]\s*(.+)$/))) {
      out.tabs = m[1].split(/[、,，]/).map(s => s.trim()).filter(Boolean);
      return;
    }
    if ((m = line.match(/^\[\s*Day\s*(\d+)(?:\s+(\d{1,2})\/(\d{1,2}))?\s*\]$/i))) {
      curBackup = null;
      if (libraryOnly) { out.errors.push(`第 ${ln} 行：專案備用庫只能匯入 [備用景點]／[備用住宿]／[備用餐廳] 段落`); cur = null; return; }
      const n = +m[1];
      if (n < 1 || n > project.numDays) { out.errors.push(`第 ${ln} 行：Day ${n} 超出專案天數（${project.numDays} 天）`); cur = null; return; }
      cur = out.days.get(n - 1) || { departTime: null, points: [] };
      out.days.set(n - 1, cur);
      return;
    }
    if ((m = line.match(/^\[\s*(備用[^\]]*?)\s*\]$/))) {
      cur = null;
      const name = m[1].trim();
      if (libraryOnly && !LIB_SECTION[name]) {
        out.errors.push(`第 ${ln} 行：「[${name}]」不是專案備用庫的頁簽（只能用 [備用景點]／[備用住宿]／[備用餐廳]），這段會略過`);
        curBackup = null; return;
      }
      if (!out.backups.has(name)) out.backups.set(name, []);
      curBackup = name;
      return;
    }
    if (line.match(/^\[.*\]$/)) {
      cur = null; curBackup = null;
      out.errors.push(`第 ${ln} 行：段落「${line}」無法辨識，這段會略過`);
      return;
    }
    if (!libraryOnly && (m = line.match(/^(?:出發|抵達)\s*(\d{1,2}:\d{2})$/))) {
      if (!cur) { out.errors.push(`第 ${ln} 行：「出發」必須放在 [Day N] 之後`); return; }
      if (parseHM(m[1]) == null) { out.errors.push(`第 ${ln} 行：時間格式錯誤`); return; }
      cur.departTime = m[1].padStart(5, '0');
      return;
    }
    if (line.includes('|')) {
      const f = line.split('|').map(s => s.trim());
      if (curBackup) {
        // 備用段落：顯示名稱 | 搜尋字 | 停留分鐘 | 備註
        const [display = '', query = '', stayTxt = '', ...noteParts] = f;
        if (!display) { out.errors.push(`第 ${ln} 行：缺少顯示名稱`); return; }
        const stay = parseStay(stayTxt, ln, out.errors);
        const note = noteParts.join('|').trim();
        out.backups.get(curBackup).push({
          kind: 'backup', line: ln, section: curBackup, type: sectionType(curBackup), display, query: query || display,
          stay, note, warn: note.startsWith('⚠'), candidates: null, choice: 0, status: 'pending',
        });
        return;
      }
      if (!cur) {
        out.errors.push(libraryOnly ? `第 ${ln} 行：地點必須放在 [備用景點] 等段落之後` : `第 ${ln} 行：地點必須放在 [Day N] 或 [備用景點] 等段落之後`);
        return;
      }
      const [typeTxt = '', display = '', query = '', stayTxt = '', modeTxt = '', ...noteParts] = f;
      const type = TYPE_MAP[typeTxt];
      if (!type) { out.errors.push(`第 ${ln} 行：類型「${typeTxt}」無法辨識（機場／景點／餐廳／住宿）`); return; }
      if (!display) { out.errors.push(`第 ${ln} 行：缺少顯示名稱`); return; }
      let mode = null;
      for (const [k, v] of Object.entries(MODE_MAP)) if (modeTxt.includes(k)) mode = v;
      if (modeTxt && !mode && !modeTxt.includes('手動')) out.errors.push(`第 ${ln} 行：交通方式「${modeTxt}」無法辨識，改用專案預設`);
      const stay = parseStay(stayTxt, ln, out.errors);
      const note = noteParts.join('|').trim();
      // 「手動 90」＝直接設定手動時間 90 分；只寫「手動」＝留空等使用者輸入
      const mm = modeTxt.match(/手動\s*(\d+(?:\.\d+)?)/);
      cur.points.push({
        kind: 'day', line: ln, type, display, query: query || display, stay,
        mode, manual: modeTxt.includes('手動'), manualMin: mm ? Number(mm[1]) : null, note,
        warn: note.startsWith('⚠'),
        candidates: null, choice: 0, status: 'pending',
      });
      return;
    }
    out.errors.push(`第 ${ln} 行：無法辨識，已忽略：${line}`);
  });
  return out;
}

function parseStay(stayTxt, ln, errors) {
  if (stayTxt === '') return null;
  const stay = Number(stayTxt);
  if (isNaN(stay) || stay < 0) { errors.push(`第 ${ln} 行：停留分鐘「${stayTxt}」不是數字，改用預設值`); return null; }
  return stay;
}

const dayPoints = (parsed) => [...parsed.days.values()].flatMap(d => d.points);
const backupPoints = (parsed) => [...parsed.backups.values()].flat();
const allPoints = (parsed) => [...dayPoints(parsed), ...backupPoints(parsed)];
const isChosen = (p) => p.choice !== SKIP && !!p.candidates?.[p.choice];

// ---------- 查詢候選（依序、每筆間隔 200ms） ----------
async function queryCandidates(points, project, onProgress, isCancelled) {
  const { AutocompleteSuggestion, AutocompleteSessionToken } = await lib('places');
  const b = project.bounds;
  for (let i = 0; i < points.length; i++) {
    if (isCancelled()) return;
    const p = points[i];
    try {
      p.token = new AutocompleteSessionToken();   // 每個點一個 session；選定後 fetchFields 結束 session
      const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input: p.query,
        locationRestriction: { north: b.n, south: b.s, east: b.e, west: b.w },
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
    if (i < points.length - 1) await sleep(QUERY_GAP_MS);
  }
}

/** 只對選定的候選 fetchFields（id、location），依序進行；結果放在 p.place */
async function resolvePoints(points, onProgress = () => {}) {
  const chosen = points.filter(isChosen);
  for (let i = 0; i < chosen.length; i++) {
    const p = chosen[i];
    const place = p.candidates[p.choice].toPlace();
    await place.fetchFields({ fields: ['id', 'location'] });
    p.place = { placeId: place.id, lat: place.location.lat(), lng: place.location.lng() };
    onProgress(i + 1, chosen.length);
    if (i < chosen.length - 1) await sleep(QUERY_GAP_MS);
  }
  return chosen;
}

const backupPt = (p) => ({ name: p.display, ...p.place, type: p.type, stayMin: p.stay ?? DEFAULT_STAY[p.type], note: p.note, query: p.query });

/** 備用點 → 專案備用庫的 [{ tabId, pt }]（不是三個頁簽之一的段落略過） */
const libEntries = (points) => points.filter(p => p.place && LIB_SECTION[p.section])
  .map(p => ({ tabId: LIB_SECTION[p.section], pt: backupPt(p) }));

// ---------- 建立規劃 ----------
/** points 已 resolve；includeBackups：備用段落放進本規劃備用庫 */
function buildPlan(parsed, project, { includeBackups }) {
  const days = Array.from({ length: project.numDays }, (_, i) => newDay(project, i));
  const manualFor = new Map();   // stop id → 匯入指定的手動分鐘
  let firstSrc = null;
  for (const [di, d] of [...parsed.days.entries()].sort((a, b) => a[0] - b[0])) {
    if (d.departTime) days[di].departTime = d.departTime;
    for (const p of d.points) {
      if (!p.place) continue;
      const stop = makeStop({ name: p.display, ...p.place, type: p.type, stayMin: p.stay ?? DEFAULT_STAY[p.type], note: p.note });
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
  const tabs = parsed.tabs?.length
    ? parsed.tabs.map(name => ({ id: uid(), name, items: [], ...(name.includes('住宿') ? { kind: HOTEL_TAB_KIND } : {}) }))
    : defaultTabs();
  if (includeBackups) {
    // 備用段落 → 同名頁簽（沒有就建立）；重複地點略過
    for (const [section, points] of parsed.backups) {
      let tab = tabs.find(t => t.name === section);
      if (!tab) { tab = { id: uid(), name: section, items: [], ...(section.includes('住宿') ? { kind: HOTEL_TAB_KIND } : {}) }; tabs.push(tab); }
      for (const p of points) {
        if (!p.place) continue;
        const pt = backupPt(p);
        if (tabs.some(t => t.items.some(x => (x.placeId && x.placeId === pt.placeId)))) continue;
        tab.items.push(makeBackupItem(pt, tab));
      }
    }
  }
  const plan = { days, backup: { tabs } };
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

// ---------- 預覽 ----------
function pickCell(p) {
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

function pointRow(p, color, extra) {
  const flag = p.warn || p.status === 'none' || p.status === 'error';
  return h('div', { class: 'ip-row' + (flag ? ' ip-flag' : '') },
    typeIcon(p.type, color),
    h('div', { class: 'ip-name' }, h('strong', {}, p.display), h('div', { class: 'small muted' }, `搜尋：${p.query}`),
      p.note ? h('div', { class: 'small' + (p.warn ? ' warn' : ' muted') }, p.note) : null),
    h('div', { class: 'ip-pickcell' }, pickCell(p)),
    h('div', { class: 'small' }, p.type === 'hotel' ? '住宿' : `${p.stay ?? DEFAULT_STAY[p.type]} 分`),
    h('div', { class: 'small' }, extra));
}

/** 備用段落的預覽列；target='lib' 時不是三個頁簽之一的段落標示略過 */
function backupRows(parsed, target) {
  const rows = [];
  for (const [section, points] of parsed.backups) {
    const libId = LIB_SECTION[section];
    const skipped = target === 'lib' && !libId;
    rows.push(h('div', { class: 'ip-day' }, `[${section}]`,
      skipped ? h('span', { class: 'warn' }, '　不是專案備用庫的頁簽，這段會略過') : null));
    if (skipped) continue;
    const color = target === 'lib' ? LIB_COLORS[libId] : '#888';
    for (const p of points) rows.push(pointRow(p, color, target === 'lib' ? '專案備用庫' : '本規劃備用庫'));
  }
  return rows;
}

/** 摘要：新增幾筆、哪些搜尋不到 */
function summaryNodes(points) {
  const done = points.every(p => p.status !== 'pending');
  if (!done) return [];
  const chosen = points.filter(isChosen).length;
  const missing = points.filter(p => p.status === 'none' || p.status === 'error');
  return [
    h('div', {}, h('strong', {}, `將匯入 ${chosen} 筆`), points.length - chosen - missing.length > 0 ? `（手動略過 ${points.length - chosen - missing.length} 筆）` : ''),
    missing.length ? h('div', { class: 'warn' }, `搜尋不到 ${missing.length} 筆：${missing.map(p => p.display).join('、')}`) : null,
  ];
}

// ---------- 匯入行程（建立規劃） ----------
/** onDone：只匯入到專案備用庫（沒有建立規劃）時呼叫，例如重新整理分支圖 */
export function openImport(project, { onDone } = {}) {
  const ta = h('textarea', { class: 'import-text', placeholder: EXAMPLE, spellcheck: 'false' });
  const body = h('div', { class: 'import' });
  const m = openModal({ title: '匯入行程', body, wide: true, actions: [] });
  // 關閉對話框或按「返回修改」時，停止尚未完成的查詢
  let closed = false;
  let runId = 0;
  m.result.then(() => { closed = true; });

  function showInput() {
    body.replaceChildren(
      h('div', { class: 'small muted pre' },
        '格式：「規劃名稱：XXX」、「備用頁簽：A、B」、「[Day N M/D]」、「出發 HH:MM」，\n' +
        '每個點一行：類型 | 顯示名稱 | 搜尋字 | 停留分鐘 | 交通方式 | 備註（「#」開頭為註解）。\n' +
        '交通方式可加「手動」（之後再輸入時間）或「手動 90」（直接設定手動時間 90 分）。\n' +
        '備用點：[備用景點]／[備用住宿]／[備用餐廳] 段落，每行：顯示名稱 | 搜尋字 | 停留分鐘 | 備註。'),
      ta,
      h('div', { class: 'row end' },
        h('button', { onClick: () => { ta.value = EXAMPLE; } }, '填入範例'),
        h('button', { onClick: () => m.close() }, '取消'),
        h('button', { class: 'primary', onClick: startParse }, '解析並查詢地點')));
  }

  async function startParse() {
    const parsed = parseImport(ta.value, project);
    parsed.target = 'plan';
    const myRun = ++runId;
    const cancelled = () => closed || myRun !== runId;
    const points = allPoints(parsed);
    if (!points.length) { toast('沒有找到任何地點，請確認格式', 'warn'); return; }
    const hasDays = dayPoints(parsed).length > 0;
    const hasBackups = backupPoints(parsed).length > 0;
    const progress = h('div', { class: 'muted' }, `查詢地點中… 0 / ${points.length}`);
    const table = h('div', { class: 'import-preview scroll' });
    const summary = h('div', { class: 'import-summary' });
    const createBtn = h('button', { class: 'primary', disabled: true, onClick: () => create(parsed, createBtn) });
    const nameIn = h('input', { type: 'text', class: 'full', value: parsed.name || '匯入的規劃' });
    const nameRow = h('label', { class: 'row' }, '規劃名稱', nameIn);
    // 備用點放置位置
    const radio = (v, label) => h('label', { class: 'row' },
      h('input', { type: 'radio', name: 'bk-target', value: v, checked: parsed.target === v, onChange: () => { parsed.target = v; refresh(); } }), label);
    const targetRow = hasBackups ? h('div', { class: 'row ip-target' }, h('strong', {}, '備用點放到：'),
      radio('plan', '本規劃備用庫'), radio('lib', '專案備用庫（加到現有，重複的略過）')) : null;

    const refresh = () => {
      // 只有備用點且放到專案備用庫：不建立規劃
      const planless = !hasDays && parsed.target === 'lib';
      nameRow.classList.toggle('hidden', planless);
      createBtn.textContent = planless ? '加入專案備用庫' : parsed.target === 'lib' && hasBackups ? '建立規劃並加入專案備用庫' : '建立規劃';
      renderPreview(parsed, table);
      summary.replaceChildren(...summaryNodes(points.filter(p => p.kind === 'day' || parsed.target === 'plan' || LIB_SECTION[p.section])));
    };
    points.forEach(p => { p.onChoice = refresh; });
    body.replaceChildren(...[
      nameRow,
      parsed.errors.length ? h('div', { class: 'import-errors' }, parsed.errors.map(e => h('div', {}, '⚠ ' + e))) : null,
      targetRow,
      progress, table, summary,
      h('div', { class: 'row end' },
        h('button', { onClick: () => { runId++; showInput(); } }, '返回修改'),
        createBtn),
    ].filter(Boolean));
    nameIn.addEventListener('input', () => { parsed.name = nameIn.value.trim(); });
    refresh();
    try {
      await queryCandidates(points, project, (done, all) => {
        if (cancelled()) return;
        progress.textContent = done < all ? `查詢地點中… ${done} / ${all}` : `查詢完成，共 ${all} 個地點。黃色列請確認。`;
        refresh();
      }, cancelled);
    } catch (e) {
      progress.textContent = '地點查詢失敗：' + e.message;
      return;
    }
    if (!cancelled()) createBtn.disabled = false;
  }

  function renderPreview(parsed, table) {
    const rows = [];
    for (const [di, d] of [...parsed.days.entries()].sort((a, b) => a[0] - b[0])) {
      const date = fmtDate(addDays(project.startDate, di));
      rows.push(h('div', { class: 'ip-day' }, `Day ${di + 1}  ${date}${d.departTime ? `　時間 ${d.departTime}` : ''}`));
      for (const p of d.points) {
        rows.push(pointRow(p, '#666', `${p.mode ? MODE_LABEL[p.mode] : '預設'}${p.manualMin != null ? `・手動 ${p.manualMin} 分` : p.manual ? '・手動' : ''}`));
      }
    }
    rows.push(...backupRows(parsed, parsed.target));
    table.replaceChildren(...rows);
  }

  async function create(parsed, btn) {
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = '建立中…';
    const hasDays = dayPoints(parsed).length > 0;
    const toLib = parsed.target === 'lib';
    try {
      await resolvePoints(allPoints(parsed), (i, n) => { btn.textContent = `取得地點資料… ${i} / ${n}`; });
      let planId = null;
      if (hasDays || !toLib) {
        const plan = buildPlan(parsed, project, { includeBackups: !toLib });
        planId = await createPlan(project.id, { name: parsed.name || '匯入的規劃', ...plan });
      }
      let libMsg = '';
      if (toLib) {
        const entries = libEntries(backupPoints(parsed));
        const r = entries.length ? await updateLibraryTx(project.id, (lib) => mergeIntoLibrary(lib, entries, 'append')) : { added: 0, dup: 0 };
        libMsg = `專案備用庫新增 ${r.added} 筆${r.dup ? `，略過重複 ${r.dup} 筆` : ''}`;
      }
      m.close(null);
      if (planId) {
        toast(`已建立規劃${libMsg ? '；' + libMsg : ''}`, 'ok', 5000);
        location.hash = `#/p/${project.id}/${planId}`;   // 開啟後自動觸發路線計算
      } else {
        toast(libMsg, 'ok', 5000);
        onDone?.();
      }
    } catch (e) {
      console.error(e);
      toast('建立失敗：' + e.message, 'error', 6000);
      btn.disabled = false; btn.textContent = label;
    }
  }

  showInput();
  setTimeout(() => ta.focus(), 30);
}

// ---------- 專案備用庫的匯入（編輯畫面） ----------
/**
 * getLibrary()：目前的專案備用庫（用來估計重複與取代筆數）
 * apply(entries, mode)：寫入（mode 'append'＝加到現有、'replace'＝取代全部），回傳 { added, dup }
 */
export function openLibraryImport(project, { getLibrary, apply }) {
  const ta = h('textarea', { class: 'import-text', placeholder: LIB_EXAMPLE, spellcheck: 'false' });
  const body = h('div', { class: 'import' });
  const m = openModal({ title: '匯入專案備用庫', body, wide: true, actions: [] });
  let closed = false;
  let runId = 0;
  m.result.then(() => { closed = true; });

  function showInput() {
    body.replaceChildren(
      h('div', { class: 'small muted pre' },
        '段落：[備用景點]、[備用住宿]、[備用餐廳]；每個點一行：顯示名稱 | 搜尋字 | 停留分鐘 | 備註\n' +
        '「#」開頭為註解；備註以「⚠」開頭表示需確認（預覽中以黃色標示）。'),
      ta,
      h('div', { class: 'row end' },
        h('button', { onClick: () => { ta.value = LIB_EXAMPLE; } }, '填入範例'),
        h('button', { onClick: () => m.close() }, '取消'),
        h('button', { class: 'primary', onClick: startParse }, '解析並查詢地點')));
  }

  async function startParse() {
    const parsed = parseImport(ta.value, project, { libraryOnly: true });
    const points = backupPoints(parsed);
    if (!points.length) { toast('沒有找到任何地點，請確認格式', 'warn'); return; }
    const myRun = ++runId;
    const cancelled = () => closed || myRun !== runId;
    let mode = 'append';
    const progress = h('div', { class: 'muted' }, `查詢地點中… 0 / ${points.length}`);
    const table = h('div', { class: 'import-preview scroll' });
    const summary = h('div', { class: 'import-summary' });
    const goBtn = h('button', { class: 'primary', disabled: true, onClick: () => go(parsed, goBtn, mode) }, '匯入');
    const radio = (v, label) => h('label', { class: 'row' },
      h('input', { type: 'radio', name: 'lib-mode', value: v, checked: mode === v, onChange: () => { mode = v; refresh(); } }), label);

    const refresh = () => {
      table.replaceChildren(...backupRows(parsed, 'lib'));
      const nodes = summaryNodes(points);
      if (nodes.length) {
        const cur = getLibrary();
        const total = Object.values(libraryCounts(cur)).reduce((a, b) => a + b, 0);
        const byTab = LIB_TABS.map(t => `${t.name.replace('備用', '')} ${points.filter(p => LIB_SECTION[p.section] === t.id && isChosen(p)).length}`).join('・');
        nodes.splice(1, 0, h('div', { class: 'small muted' }, byTab));
        if (mode === 'append') {
          // 依地點 ID 估計與現有重複的筆數（實際以匯入時為準）
          const ids = new Set(cur.tabs.flatMap(t => t.items.map(i => i.placeId)).filter(Boolean));
          const dup = points.filter(p => isChosen(p) && ids.has(p.candidates[p.choice].placeId)).length;
          if (dup) nodes.push(h('div', { class: 'small muted' }, `其中約 ${dup} 筆與現有地點重複，會略過`));
        } else if (total) {
          nodes.push(h('div', { class: 'warn' }, `取代全部：會先刪除專案備用庫現有的 ${total} 個點`));
        }
      }
      summary.replaceChildren(...nodes);
    };
    points.forEach(p => { p.onChoice = refresh; });
    body.replaceChildren(...[
      parsed.errors.length ? h('div', { class: 'import-errors' }, parsed.errors.map(e => h('div', {}, '⚠ ' + e))) : null,
      progress, table, summary,
      h('div', { class: 'row ip-target' }, h('strong', {}, '匯入方式：'), radio('append', '加到現有（重複的略過）'), radio('replace', '取代全部')),
      h('div', { class: 'row end' },
        h('button', { onClick: () => { runId++; showInput(); } }, '返回修改'),
        goBtn),
    ].filter(Boolean));
    refresh();
    try {
      await queryCandidates(points, project, (done, all) => {
        if (cancelled()) return;
        progress.textContent = done < all ? `查詢地點中… ${done} / ${all}` : `查詢完成，共 ${all} 個地點。黃色列請確認。`;
        refresh();
      }, cancelled);
    } catch (e) {
      progress.textContent = '地點查詢失敗：' + e.message;
      return;
    }
    if (!cancelled()) goBtn.disabled = false;
  }

  async function go(parsed, btn, mode) {
    const points = backupPoints(parsed);
    if (!points.some(isChosen)) { toast('沒有可匯入的地點', 'warn'); return; }
    if (mode === 'replace') {
      const total = Object.values(libraryCounts(getLibrary())).reduce((a, b) => a + b, 0);
      if (total && !(await confirmDialog(`取代全部會刪除專案備用庫現有的 ${total} 個點，改成這次匯入的內容。\n確定取代？`, '取代全部', true))) return;
    }
    btn.disabled = true; btn.textContent = '匯入中…';
    try {
      await resolvePoints(points, (i, n) => { btn.textContent = `取得地點資料… ${i} / ${n}`; });
      const r = apply(libEntries(points), mode);
      m.close(null);
      toast(`已${mode === 'replace' ? '取代為' : '新增'} ${r.added} 筆${r.dup ? `，略過重複 ${r.dup} 筆` : ''}`, 'ok', 5000);
    } catch (e) {
      console.error(e);
      toast('匯入失敗：' + e.message, 'error', 6000);
      btn.disabled = false; btn.textContent = '匯入';
    }
  }

  showInput();
  setTimeout(() => ta.focus(), 30);
}

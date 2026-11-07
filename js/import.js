// 匯入行程：貼上文字 → 解析 → 依序以 AutocompleteSuggestion 查候選 → 預覽改選 → 建立規劃
import { lib } from './maps-loader.js';
import {
  newDay, makeStop, newLeg, normalizePlan, prevPoint, defaultTabs, DEFAULT_STAY, START_AIRPORT_STAY,
  HOTEL_TAB_KIND, MODE_LABEL,
} from './state.js';
import { createPlan } from './store.js';
import { typeIcon } from './markers.js';
import { h, openModal, toast, uid, fmtDate, addDays, parseHM } from './utils.js';

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
景點 | 摩周湖 | 摩周湖 第一展望台 | 40 | 大眾運輸 手動 90 |`;

// ---------- 解析 ----------
/**
 * 回傳 { name, tabs:[名稱], days: Map<dayIdx, { departTime, points:[] }>, errors:[] }
 * point: { line, type, display, query, stay, mode, manual, note, warn }
 */
export function parseImport(text, project) {
  const out = { name: '', tabs: null, days: new Map(), errors: [] };
  let cur = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    const ln = i + 1;
    if (!line || line.startsWith('#')) return;
    let m;
    if ((m = line.match(/^規劃名稱\s*[:：]\s*(.+)$/))) { out.name = m[1].trim(); return; }
    if ((m = line.match(/^備用頁簽\s*[:：]\s*(.+)$/))) {
      out.tabs = m[1].split(/[、,，]/).map(s => s.trim()).filter(Boolean);
      return;
    }
    if ((m = line.match(/^\[\s*Day\s*(\d+)(?:\s+(\d{1,2})\/(\d{1,2}))?\s*\]$/i))) {
      const n = +m[1];
      if (n < 1 || n > project.numDays) { out.errors.push(`第 ${ln} 行：Day ${n} 超出專案天數（${project.numDays} 天）`); cur = null; return; }
      cur = out.days.get(n - 1) || { departTime: null, points: [] };
      out.days.set(n - 1, cur);
      return;
    }
    if ((m = line.match(/^(?:出發|抵達)\s*(\d{1,2}:\d{2})$/))) {
      if (!cur) { out.errors.push(`第 ${ln} 行：「出發」必須放在 [Day N] 之後`); return; }
      if (parseHM(m[1]) == null) { out.errors.push(`第 ${ln} 行：時間格式錯誤`); return; }
      cur.departTime = m[1].padStart(5, '0');
      return;
    }
    if (line.includes('|')) {
      if (!cur) { out.errors.push(`第 ${ln} 行：地點必須放在 [Day N] 之後`); return; }
      const f = line.split('|').map(s => s.trim());
      const [typeTxt = '', display = '', query = '', stayTxt = '', modeTxt = '', ...noteParts] = f;
      const type = TYPE_MAP[typeTxt];
      if (!type) { out.errors.push(`第 ${ln} 行：類型「${typeTxt}」無法辨識（機場／景點／餐廳／住宿）`); return; }
      if (!display) { out.errors.push(`第 ${ln} 行：缺少顯示名稱`); return; }
      let mode = null;
      for (const [k, v] of Object.entries(MODE_MAP)) if (modeTxt.includes(k)) mode = v;
      if (modeTxt && !mode && !modeTxt.includes('手動')) out.errors.push(`第 ${ln} 行：交通方式「${modeTxt}」無法辨識，改用專案預設`);
      const stay = stayTxt === '' ? null : Number(stayTxt);
      if (stay != null && (isNaN(stay) || stay < 0)) out.errors.push(`第 ${ln} 行：停留分鐘「${stayTxt}」不是數字，改用預設值`);
      const note = noteParts.join('|').trim();
      // 「手動 90」＝直接設定手動時間 90 分；只寫「手動」＝留空等使用者輸入
      const mm = modeTxt.match(/手動\s*(\d+(?:\.\d+)?)/);
      cur.points.push({
        line: ln, type, display, query: query || display,
        stay: stay != null && !isNaN(stay) && stay >= 0 ? stay : null,
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

// ---------- 查詢候選（依序、每筆間隔 200ms） ----------
async function queryCandidates(parsed, project, onProgress, isCancelled) {
  const { AutocompleteSuggestion, AutocompleteSessionToken } = await lib('places');
  const b = project.bounds;
  const points = [...parsed.days.values()].flatMap(d => d.points);
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

// ---------- 建立規劃 ----------
async function buildPlan(parsed, project) {
  const days = Array.from({ length: project.numDays }, (_, i) => newDay(project, i));
  const chosen = [];
  const manualFor = new Map();   // stop id → 匯入指定的手動分鐘
  for (const [di, d] of [...parsed.days.entries()].sort((a, b) => a[0] - b[0])) {
    if (d.departTime) days[di].departTime = d.departTime;
    for (const p of d.points) if (p.choice !== SKIP && p.candidates?.[p.choice]) chosen.push({ di, p });
  }
  // 只對選定的候選 fetchFields（id、location），依序進行
  for (let i = 0; i < chosen.length; i++) {
    const { di, p } = chosen[i];
    const place = p.candidates[p.choice].toPlace();
    await place.fetchFields({ fields: ['id', 'location'] });
    const stop = makeStop({
      name: p.display, placeId: place.id, lat: place.location.lat(), lng: place.location.lng(),
      type: p.type, stayMin: p.stay ?? DEFAULT_STAY[p.type], note: p.note,
    });
    if (p.mode || p.manual) {
      stop.leg = newLeg(p.mode || project.defaultMode || 'drive');
      if (p.manual && p.manualMin == null) stop.leg.needManual = true;
    }
    days[di].stops.push(stop);
    if (p.manualMin != null) manualFor.set(stop.id, p.manualMin);
    if (i < chosen.length - 1) await sleep(QUERY_GAP_MS);
  }
  // 行程第一點若為機場：停留時間寫入起點停留時間（未填則 45 分）
  const first = days.flatMap(d => d.stops)[0];
  if (first && first.type === 'airport') {
    const src = chosen[0]?.p;
    first.stayMin = src?.stay ?? START_AIRPORT_STAY;
    first.startStayInit = true;
  }
  const tabs = parsed.tabs?.length
    ? parsed.tabs.map(name => ({ id: uid(), name, items: [], ...(name.includes('住宿') ? { kind: HOTEL_TAB_KIND } : {}) }))
    : defaultTabs();
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

// ---------- 對話框 ----------
export function openImport(project) {
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
        '交通方式可加「手動」（之後再輸入時間）或「手動 90」（直接設定手動時間 90 分）。'),
      ta,
      h('div', { class: 'row end' },
        h('button', { onClick: () => { ta.value = EXAMPLE; } }, '填入範例'),
        h('button', { onClick: () => m.close() }, '取消'),
        h('button', { class: 'primary', onClick: startParse }, '解析並查詢地點')));
  }

  async function startParse() {
    const parsed = parseImport(ta.value, project);
    const myRun = ++runId;
    const cancelled = () => closed || myRun !== runId;
    const total = [...parsed.days.values()].reduce((n, d) => n + d.points.length, 0);
    if (!total) { toast('沒有找到任何地點，請確認格式', 'warn'); return; }
    const progress = h('div', { class: 'muted' }, `查詢地點中… 0 / ${total}`);
    const table = h('div', { class: 'import-preview scroll' });
    const createBtn = h('button', { class: 'primary', disabled: true, onClick: () => create(parsed, createBtn) }, '建立規劃');
    const nameIn = h('input', { type: 'text', class: 'full', value: parsed.name || '匯入的規劃' });
    body.replaceChildren(...[
      h('label', { class: 'row' }, '規劃名稱', nameIn),
      parsed.errors.length ? h('div', { class: 'import-errors' }, parsed.errors.map(e => h('div', {}, '⚠ ' + e))) : null,
      progress, table,
      h('div', { class: 'row end' },
        h('button', { onClick: () => { runId++; showInput(); } }, '返回修改'),
        createBtn),
    ].filter(Boolean));
    nameIn.addEventListener('input', () => { parsed.name = nameIn.value.trim(); });
    renderPreview(parsed, table);
    try {
      await queryCandidates(parsed, project, (done, all) => {
        if (cancelled()) return;
        progress.textContent = done < all ? `查詢地點中… ${done} / ${all}` : `查詢完成，共 ${all} 個地點。黃色列請確認。`;
        renderPreview(parsed, table);
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
        const flag = p.warn || p.status === 'none' || p.status === 'error';
        let pick;
        if (p.status === 'pending') pick = h('span', { class: 'muted' }, '查詢中…');
        else {
          const opts = (p.candidates || []).map((c, i) => h('option', { value: i },
            `${c.mainText?.text || c.text?.text || ''}${c.secondaryText?.text ? ' — ' + c.secondaryText.text : ''}`));
          opts.push(h('option', { value: SKIP }, '略過此點'));
          pick = h('select', { class: 'ip-pick', onChange: (e) => {
            p.choice = e.target.value === SKIP ? SKIP : +e.target.value;
          } }, opts);
          pick.value = String(p.choice);
          if (!p.candidates?.length) pick = h('span', {}, h('span', { class: 'warn' }, p.status === 'error' ? '查詢失敗，' : '查無候選，'), '將略過此點');
        }
        rows.push(h('div', { class: 'ip-row' + (flag ? ' ip-flag' : '') },
          typeIcon(p.type, '#666'),
          h('div', { class: 'ip-name' }, h('strong', {}, p.display), h('div', { class: 'small muted' }, `搜尋：${p.query}`),
            p.note ? h('div', { class: 'small' + (p.warn ? ' warn' : ' muted') }, p.note) : null),
          h('div', { class: 'ip-pickcell' }, pick),
          h('div', { class: 'small' }, p.type === 'hotel' ? '住宿' : `${p.stay ?? DEFAULT_STAY[p.type]} 分`),
          h('div', { class: 'small' }, `${p.mode ? MODE_LABEL[p.mode] : '預設'}${p.manualMin != null ? `・手動 ${p.manualMin} 分` : p.manual ? '・手動' : ''}`)));
      }
    }
    table.replaceChildren(...rows);
  }

  async function create(parsed, btn) {
    btn.disabled = true; btn.textContent = '建立中…';
    try {
      const plan = await buildPlan(parsed, project);
      const id = await createPlan(project.id, { name: parsed.name || '匯入的規劃', ...plan });
      m.close(null);
      toast('已建立規劃', 'ok');
      location.hash = `#/p/${project.id}/${id}`;   // 開啟後自動觸發路線計算
    } catch (e) {
      console.error(e);
      toast('建立失敗：' + e.message, 'error', 6000);
      btn.disabled = false; btn.textContent = '建立規劃';
    }
  }

  showInput();
  setTimeout(() => ta.focus(), 30);
}

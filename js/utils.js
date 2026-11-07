// 共用小工具：DOM 建立、時間格式、對話框、polyline 編碼等

export const $ = (sel, root = document) => root.querySelector(sel);

/** 建立 DOM 元素：h('div', {class:'x', onClick: fn}, child1, 'text') */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
      }
    }
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') value = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  if (value !== undefined) el.value = value;
  return el;
}

/** 下拉選單 options: [{value,label}] */
export function selectEl(options, value, attrs = {}) {
  return h('select', { ...attrs, value: value ?? '' },
    options.map(o => h('option', { value: o.value }, o.label)));
}

export function debounce(fn, ms) {
  let t = null, lastArgs = null;
  const d = (...args) => { lastArgs = args; clearTimeout(t); t = setTimeout(() => { t = null; fn(...lastArgs); }, ms); };
  d.cancel = () => { clearTimeout(t); t = null; };
  d.flush = () => { if (t) { clearTimeout(t); t = null; return fn(...(lastArgs || [])); } };
  d.pending = () => t !== null;
  return d;
}

export function uid() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

export const clone = (o) => JSON.parse(JSON.stringify(o ?? null));

// ---------- 時間 ----------
const pad = (n) => String(n).padStart(2, '0');

export function parseHM(s) {
  if (!s || !/^\d{1,2}:\d{2}$/.test(s)) return null;
  const [hh, mm] = s.split(':').map(Number);
  return hh * 60 + mm;
}

/** 分鐘 → "HH:MM"，超過 24 小時加「翌」 */
export function fmtHM(min) {
  if (min == null || isNaN(min)) return '--:--';
  const m = Math.round(min);
  const day = Math.floor(m / 1440);
  const r = ((m % 1440) + 1440) % 1440;
  return (day > 0 ? '翌' : '') + `${pad(Math.floor(r / 60))}:${pad(r % 60)}`;
}

export function fmtDur(min) {
  if (min == null || isNaN(min)) return '—';
  const m = Math.round(min);
  if (m < 60) return `${m} 分`;
  return `${Math.floor(m / 60)} 小時${m % 60 ? ` ${m % 60} 分` : ''}`;
}

/** 精簡時間（地圖標籤用）：41分、1時5分 */
export function fmtShortDur(min) {
  const m = Math.round(min);
  if (m < 60) return `${m}分`;
  return `${Math.floor(m / 60)}時${m % 60 ? `${m % 60}分` : ''}`;
}

export function fmtDist(meters) {
  if (meters == null) return '—';
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}

export function fmtDateTime(ms) {
  if (!ms) return '—';
  const d = new Date(typeof ms === 'number' ? ms : ms.toMillis?.() ?? ms);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- 日期（字串 YYYY-MM-DD，以 UTC 計算避免時區偏移） ----------
export function addDays(dateStr, n) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const WD = ['日', '一', '二', '三', '四', '五', '六'];
export function fmtDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00Z');
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WD[d.getUTCDay()]}）`;
}

/**
 * 大眾運輸查詢用的出發時間：
 * 從今天起最近一個與行程日期同星期幾的日子，時間為 minutes（日本時區 UTC+9）。
 */
export function transitDepartureDate(tripDateStr, minutes) {
  const JST = 9 * 3600e3;
  const targetDow = new Date(tripDateStr + 'T00:00:00Z').getUTCDay();
  const nowJ = new Date(Date.now() + JST);
  const add = (targetDow - nowJ.getUTCDay() + 7) % 7;
  const mins = Math.max(0, Math.min(Math.round(minutes ?? 540), 1439));
  let t = Date.UTC(nowJ.getUTCFullYear(), nowJ.getUTCMonth(), nowJ.getUTCDate() + add) + mins * 60e3 - JST;
  if (t < Date.now()) t += 7 * 86400e3; // 今天但時間已過 → 下週同一天
  return new Date(t);
}

// ---------- 座標 ----------
export const coordKey = (p) => `${(+p.lat).toFixed(6)},${(+p.lng).toFixed(6)}`;
export const samePlace = (a, b) =>
  !!a && !!b && ((a.placeId && b.placeId && a.placeId === b.placeId) || coordKey(a) === coordKey(b));

/** Google Encoded Polyline 編碼 */
export function encodePath(points) {
  let out = '', pLat = 0, pLng = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5), lng = Math.round(p.lng * 1e5);
    out += enc(lat - pLat) + enc(lng - pLng);
    pLat = lat; pLng = lng;
  }
  return out;
}
export function decodePath(str) {
  const pts = []; let i = 0, lat = 0, lng = 0;
  while (str && i < str.length) {
    for (const which of [0, 1]) {
      let b, shift = 0, res = 0;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = res & 1 ? ~(res >> 1) : res >> 1;
      if (which === 0) lat += d; else lng += d;
    }
    pts.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return pts;
}

// ---------- 提示與對話框 ----------
export function toast(msg, type = 'info', ms = 3500) {
  const root = document.getElementById('toast-root');
  const t = h('div', { class: `toast toast-${type}` }, msg);
  root.append(t);
  setTimeout(() => t.classList.add('hide'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

/** 開啟對話框；actions: [{label, value, class}]，回傳 {el, close, result(Promise)} */
export function openModal({ title, body, actions = [{ label: '關閉', value: null }], wide = false, dismissValue = null }) {
  let resolveFn;
  const result = new Promise(r => (resolveFn = r));
  const overlay = h('div', { class: 'modal-overlay' });
  const close = (v = dismissValue) => { overlay.remove(); resolveFn(v); };
  const box = h('div', { class: 'modal' + (wide ? ' modal-wide' : '') },
    h('div', { class: 'modal-head' }, h('h3', {}, title || ''), h('button', { class: 'icon-btn', title: '關閉', onClick: () => close() }, '✕')),
    h('div', { class: 'modal-body' }, body || ''),
    actions.length ? h('div', { class: 'modal-actions' },
      actions.map(a => h('button', { class: a.class || '', onClick: () => close(a.value) }, a.label))) : null);
  overlay.append(box);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.body.append(overlay);
  return { el: box, close, result };
}

export function confirmDialog(message, okLabel = '確定', danger = false) {
  return openModal({
    title: '請確認', body: h('p', { class: 'pre' }, message),
    actions: [{ label: '取消', value: false }, { label: okLabel, value: true, class: danger ? 'danger' : 'primary' }],
    dismissValue: false,
  }).result;
}

export function choose(title, message, options) {
  return openModal({ title, body: h('p', { class: 'pre' }, message), actions: options, dismissValue: null }).result;
}

export function promptDialog(title, defaultValue = '', placeholder = '') {
  const input = h('input', { type: 'text', value: defaultValue, placeholder, class: 'full' });
  const m = openModal({
    title, body: input,
    actions: [{ label: '取消', value: null }, { label: '確定', value: '__ok__', class: 'primary' }],
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.close('__ok__'); });
  setTimeout(() => { input.focus(); input.select(); }, 30);
  return m.result.then(v => (v === '__ok__' ? input.value.trim() : null));
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('已複製到剪貼簿', 'ok'); }
  catch {
    const ta = h('textarea', {}, text); document.body.append(ta); ta.select();
    document.execCommand('copy'); ta.remove(); toast('已複製到剪貼簿', 'ok');
  }
}

export function downloadFile(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const num = (v, fallback = null) => {
  if (v === '' || v == null) return fallback;
  const n = Number(v);
  return isNaN(n) ? fallback : n;
};

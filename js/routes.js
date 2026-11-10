// 路線查詢：記憶體 → Firestore routeCache → Routes API（Maps JS Route.computeRoutes）
// 計費：只用基本功能（不開路況、無中途點）→ Compute Routes Essentials
import { lib } from './maps-loader.js?v=2026-11-10-1';
import { emit } from './state.js?v=2026-11-10-1';
import { coordKey, encodePath, decodePath, debounce } from './utils.js?v=2026-11-10-1';
import { loadRouteCache, getRouteCacheDoc, setRouteCacheDoc } from './store.js?v=2026-11-10-1';

const GOOGLE_MODE = { drive: 'DRIVING', transit: 'TRANSIT', walk: 'WALKING' };
export const URL_MODE = { drive: 'driving', transit: 'transit', walk: 'walking', other: 'driving' };

const mem = new Map();      // key -> { distanceMeters, durationSec, noRoute, path:[{lat,lng}] }
const pending = new Set();
const failed = new Map();   // key -> 錯誤訊息（本次開啟期間不自動重試）
let queue = [];
let running = 0;
let projectId = null;
const MAX_PARALLEL = 2;

const notify = debounce(() => emit('routes'), 150);

export function routeKey(from, to, mode) {
  return `${coordKey(from)}_${coordKey(to)}_${mode}`;
}

function fromDoc(d) {
  return {
    distanceMeters: d.distanceMeters ?? null, durationSec: d.durationSec ?? null,
    noRoute: !!d.noRoute, path: d.path ? decodePath(d.path) : null,
  };
}

/** 開啟專案時一次載入整個路線快取 */
export async function initRouteCache(pid) {
  projectId = pid;
  mem.clear(); pending.clear(); failed.clear(); queue = [];
  try {
    const docs = await loadRouteCache(pid);
    if (projectId !== pid) return;
    docs.forEach(d => mem.set(d.key, fromDoc(d)));
  } catch (e) { console.warn('路線快取載入失敗', e); }
}

/** 取得某路段資訊（只讀快取，不會呼叫 API） */
export function getRouteInfo(from, to, mode) {
  if (mode === 'other') return { status: 'other', key: null };
  const key = routeKey(from, to, mode);
  const m = mem.get(key);
  if (m) return { status: m.noRoute ? 'noRoute' : 'ok', key, ...m };
  if (failed.has(key)) return { status: 'error', key, error: failed.get(key) };
  return { status: 'pending', key };
}

/** 要求計算路段；只有快取都沒有的 key 才會排入查詢 */
export function requestRoutes(jobs) {
  let added = false;
  for (const j of jobs) {
    if (j.mode === 'other') continue;
    const key = routeKey(j.from, j.to, j.mode);
    if (mem.has(key) || pending.has(key) || failed.has(key)) continue;
    if (coordKey(j.from) === coordKey(j.to)) {   // 同一點：距離 0，不必查
      mem.set(key, { distanceMeters: 0, durationSec: 0, noRoute: false, path: null });
      added = true; continue;
    }
    pending.add(key);
    queue.push({ ...j, key, pid: projectId });
  }
  if (added) notify();
  pump();
}

export function retryRoute(key) {
  failed.delete(key);
  emit('routesRetry');
}

function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    running++;
    runJob(job).finally(() => { running--; pending.delete(job.key); notify(); pump(); });
  }
}

async function runJob(job) {
  try {
    // 第二層：Firestore（可能別人剛算過）
    const doc = await getRouteCacheDoc(job.pid, job.key);
    if (job.pid !== projectId) return;
    if (doc) { mem.set(job.key, fromDoc(doc)); return; }
    // 第三層：呼叫 Routes API
    const res = await callApi(job);
    if (job.pid !== projectId) return;
    mem.set(job.key, res);
    await setRouteCacheDoc(job.pid, job.key, {
      distanceMeters: res.distanceMeters, durationSec: res.durationSec, noRoute: res.noRoute,
      path: res.path ? encodePath(res.path) : null,
    });
  } catch (e) {
    console.warn('路線查詢失敗', job.key, e);
    failed.set(job.key, e?.message || String(e));
  }
}

const NO_ROUTE_PATTERNS = /NOT_FOUND|ZERO_RESULTS|no route|找不到路線/i;

async function callApi(job) {
  const { Route } = await lib('routes');
  const request = {
    origin: { lat: job.from.lat, lng: job.from.lng },
    destination: { lat: job.to.lat, lng: job.to.lng },
    travelMode: GOOGLE_MODE[job.mode],
    fields: ['distanceMeters', 'durationMillis', 'path'],
  };
  // 開車明確指定不使用路況（TRAFFIC_UNAWARE）→ 維持 Essentials 計費
  if (job.mode === 'drive') request.routingPreference = 'TRAFFIC_UNAWARE';
  if (job.mode === 'transit' && job.departAt) request.departureTime = job.departAt;
  let routes;
  try {
    ({ routes } = await Route.computeRoutes(request));
  } catch (e) {
    if (NO_ROUTE_PATTERNS.test(e?.message || '')) return { distanceMeters: null, durationSec: null, noRoute: true, path: null };
    throw e;
  }
  const r = routes?.[0];
  if (!r || r.durationMillis == null) return { distanceMeters: null, durationSec: null, noRoute: true, path: null };
  const path = (r.path || []).map(p => ({
    lat: typeof p.lat === 'function' ? p.lat() : p.lat,
    lng: typeof p.lng === 'function' ? p.lng() : p.lng,
  }));
  return {
    distanceMeters: r.distanceMeters ?? null,
    durationSec: Math.round(r.durationMillis / 1000),
    noRoute: false,
    path: path.length ? path : null,
  };
}

/** 「在 Google Maps 開啟此段」連結 */
export function gmapsDirUrl(from, to, mode) {
  const q = new URLSearchParams({
    api: '1', origin: `${from.lat},${from.lng}`, destination: `${to.lat},${to.lng}`, travelmode: URL_MODE[mode] || 'driving',
  });
  return 'https://www.google.com/maps/dir/?' + q;
}

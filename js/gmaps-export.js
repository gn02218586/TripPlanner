// 匯出成 Google 地圖可用的格式：KML（Google 我的地圖 My Maps 匯入用）與每天的 Google Maps 導航連結
import { state, prevPoint, TYPE_LABEL, MODE_LABEL } from './state.js';
import { computeSchedule } from './schedule.js';
import { getRouteInfo } from './routes.js';
import { stopLabelMap, dayColor } from './markers.js';
import { fmtHM, fmtDist, fmtShortDur, fmtDate, coordKey } from './utils.js';

// ---------- 共用 ----------
/** 網站的每天顏色（#rrggbb 或 hsl()）→ KML 顏色 aabbggrr */
function kmlColor(css, alpha = 'ff') {
  let r, g, b;
  const hex = css.match(/^#([0-9a-f]{6})$/i);
  const hsl = css.match(/^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i);
  if (hex) {
    r = parseInt(hex[1].slice(0, 2), 16); g = parseInt(hex[1].slice(2, 4), 16); b = parseInt(hex[1].slice(4, 6), 16);
  } else if (hsl) {
    const H = +hsl[1] / 360, S = +hsl[2] / 100, L = +hsl[3] / 100;
    const q = L < 0.5 ? L * (1 + S) : L + S - L * S, p = 2 * L - q;
    const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    [r, g, b] = [f(H + 1 / 3), f(H), f(H - 1 / 3)].map(v => Math.round(v * 255));
  } else { r = g = b = 0x77; }
  const x = (v) => v.toString(16).padStart(2, '0');
  return alpha + x(b) + x(g) + x(r);
}

const esc = (s) => String(s ?? '').replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const coord = (p) => `${(+p.lng).toFixed(6)},${(+p.lat).toFixed(6)},0`;

// Google Earth 標準圖示（My Maps 匯入時可能換成它自己的相近圖示，但顏色通常會保留）
const ICON = {
  spot: 'https://maps.google.com/mapfiles/kml/shapes/placemark_circle.png',
  food: 'https://maps.google.com/mapfiles/kml/shapes/dining.png',
  hotel: 'https://maps.google.com/mapfiles/kml/shapes/lodging.png',
  airport: 'https://maps.google.com/mapfiles/kml/shapes/airports.png',
};

/** 標記名稱：「1-1 幣舞橋」「住1 釧路市區飯店」「✈去 釧路機場」 */
function placeName(s, labels) {
  const label = (labels.get(s.id) || '').replace('🍴', '');
  return label ? `${label} ${s.name}` : s.name;
}

// ---------- KML ----------
function styles(days) {
  const out = [];
  days.forEach(di => {
    const c = dayColor(di, state.plan.days.length);
    for (const t of Object.keys(ICON)) {
      out.push(`<Style id="d${di}-${t}"><IconStyle><color>${kmlColor(c)}</color><scale>1.1</scale><Icon><href>${ICON[t]}</href></Icon></IconStyle><LabelStyle><scale>0.9</scale></LabelStyle></Style>`);
    }
    out.push(`<Style id="d${di}-line"><LineStyle><color>${kmlColor(c, 'dd')}</color><width>4</width></LineStyle></Style>`);
  });
  return out.join('\n');
}

function dayFolder(di, sched, labels, { includeOrigin }) {
  const day = state.plan.days[di];
  const sd = sched[di];
  const parts = [];
  // 單天檔案：把起點（前一天最後一點）也放進來，方便單獨看這一天
  const origin = !sd.isTripStart ? prevPoint(state.plan, di, 0) : null;
  if (includeOrigin && origin) {
    parts.push(placemark(`起點 ${placeName(origin, labels)}`, [
      `類型：${TYPE_LABEL[origin.type]}（前一天最後一點）`, `出發：${day.departTime}`,
    ], origin, `d${di}-${origin.type}`));
  }
  day.stops.forEach((s, i) => {
    const st = sd.stops[i];
    const lines = [`類型：${TYPE_LABEL[s.type]}`];
    if (st.arr != null) lines.push(`抵達：${fmtHM(st.arr)}`);
    if (s.type !== 'hotel') { lines.push(`停留：${s.stayMin ?? 0} 分`); lines.push(`出發：${fmtHM(st.dep)}`); }
    if (s.note) lines.push(`備註：${s.note}`);
    parts.push(placemark(placeName(s, labels), lines, s, `d${di}-${s.type}`));
  });
  // 路線：routeCache 的 path；沒有 path 就用直線
  day.stops.forEach((s, i) => {
    const st = sd.stops[i];
    if (!st.leg || !st.from) return;
    const inf = getRouteInfo(st.from, s, s.leg.mode);
    const path = inf.status === 'ok' && inf.path?.length ? inf.path : [st.from, s];
    const lines = [`交通方式：${MODE_LABEL[s.leg.mode]}`];
    if (st.leg.distance != null) lines.push(`距離：${fmtDist(st.leg.distance)}`);
    lines.push(`時間：${st.leg.minutes != null ? fmtShortDur(st.leg.minutes) : '未定'}${st.leg.source === 'manual' ? '（手動）' : ''}`);
    parts.push(`<Placemark><name>${esc(`${st.from.name} → ${s.name}`)}</name><description>${esc(lines.join('\n'))}</description><styleUrl>#d${di}-line</styleUrl><LineString><tessellate>1</tessellate><coordinates>${path.map(coord).join(' ')}</coordinates></LineString></Placemark>`);
  });
  return `<Folder><name>${esc(`Day ${di + 1} ${fmtDate(day.date)}`)}</name>\n${parts.join('\n')}\n</Folder>`;
}

function placemark(name, lines, p, styleId) {
  return `<Placemark><name>${esc(name)}</name><description>${esc(lines.join('\n'))}</description><styleUrl>#${styleId}</styleUrl><Point><coordinates>${coord(p)}</coordinates></Point></Placemark>`;
}

/** dayIdxs：要匯出的天（陣列）；單天檔案會加入當天起點 */
export function buildKML(dayIdxs, title) {
  const sched = computeSchedule(state.plan, state.project);
  const labels = stopLabelMap(state.plan);
  const single = dayIdxs.length === 1;
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document><name>${esc(title)}</name>
${styles(dayIdxs)}
${dayIdxs.map(di => dayFolder(di, sched, labels, { includeOrigin: single })).join('\n')}
</Document>
</kml>
`;
}

/** 有行程點的天 */
export const daysWithStops = () => state.plan.days.map((d, i) => i).filter(i => state.plan.days[i].stops.length);

// ---------- 導航連結 ----------
/** 每天的路線點：起點（第一天＝第一點，其他天＝前一天最後一點）＋當天各點 */
function dayRoutePoints(di) {
  const day = state.plan.days[di];
  const origin = prevPoint(state.plan, di, 0);
  const pts = origin ? [origin, ...day.stops] : [...day.stops];
  return pts.filter((p, i) => i === 0 || coordKey(p) !== coordKey(pts[i - 1]));   // 去掉連續重複的點
}

function navUrl(points) {
  const o = points[0], d = points[points.length - 1], mid = points.slice(1, -1);
  const q = new URLSearchParams({ api: '1', origin: `${o.lat},${o.lng}`, destination: `${d.lat},${d.lng}`, travelmode: 'driving' });
  if (o.placeId) q.set('origin_place_id', o.placeId);
  if (d.placeId) q.set('destination_place_id', d.placeId);
  if (mid.length) {
    q.set('waypoints', mid.map(p => `${p.lat},${p.lng}`).join('|'));
    // waypoint_place_ids 必須與 waypoints 一一對應：全部都有 place_id 時才帶
    if (mid.every(p => p.placeId)) q.set('waypoint_place_ids', mid.map(p => p.placeId).join('|'));
  }
  return 'https://www.google.com/maps/dir/?' + q;
}

/**
 * 每天的導航連結；中途點超過 maxWaypoints 時拆成多段（前一段終點＝下一段起點）
 * 回傳 [{ di, segments:[{ url, from, to, n }] }]
 */
export function dayNavLinks(maxWaypoints = 9) {
  return state.plan.days.map((_, di) => {
    const pts = dayRoutePoints(di);
    if (pts.length < 2) return { di, segments: [] };
    const segments = [];
    for (let i = 0; i < pts.length - 1;) {
      const end = Math.min(i + maxWaypoints + 1, pts.length - 1);
      const seg = pts.slice(i, end + 1);
      segments.push({ url: navUrl(seg), from: seg[0].name, to: seg[seg.length - 1].name, n: seg.length });
      i = end;
    }
    return { di, segments };
  });
}

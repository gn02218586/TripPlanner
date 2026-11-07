// 標記與圖示：地圖、行程清單、備用庫共用同一套外觀
import { h, samePlace } from './utils.js';

const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0aa6a6', '#d6338a', '#808000', '#9a6324', '#000075'];
/** 依天數自動配色 */
export function dayColor(i, n) {
  if (i == null || i < 0) return '#777';
  if (n <= PALETTE.length) return PALETTE[i % PALETTE.length];
  return `hsl(${Math.round((i * 360) / n)}, 70%, 42%)`;
}
export const BACKUP_COLOR = '#8a8a8a';
export const REF_COLOR = '#7b3fe4';

export const TYPE_GLYPH = { spot: '', food: '🍴', hotel: '', airport: '✈' };

/** 地圖標記內容 */
export function markerEl({ type = 'spot', label = '', color = '#555', faded = false, small = false }) {
  const el = h('div', { class: `mk mk-${type}${faded ? ' mk-faded' : ''}${small ? ' mk-small' : ''}`, style: { '--c': color } },
    h('span', { class: 'mk-body' }, label));
  return el;
}

/** 清單用小圖示 */
export function typeIcon(type = 'spot', color = '#555') {
  const glyph = type === 'food' ? '🍴' : type === 'airport' ? '✈' : type === 'hotel' ? '住' : '';
  return h('span', { class: `ti ti-${type}`, style: { '--c': color }, title: type }, glyph);
}

/**
 * 計算行程標記：
 * - 景點／餐廳：天-站（只計景點與餐廳）
 * - 住宿：住N，連住同一間合併成「住2-3」
 * - 機場：Day1 第一點「✈去」、最後一天最後一點「✈回」
 * 回傳 [{ stops:[stop...], dayIdx, days:[...], type, label, short }]
 */
export function buildTripMarkers(plan) {
  const out = [];
  const lastDay = plan.days.length - 1;
  let hotelGroup = null;
  plan.days.forEach((day, di) => {
    let n = 0;
    day.stops.forEach((s, i) => {
      if (s.type === 'spot' || s.type === 'food') {
        n++;
        const g = s.type === 'food' ? '🍴' : '';
        out.push({ stops: [s], dayIdx: di, days: [di], type: s.type, label: `${g}${di + 1}-${n}`, short: `${g}${n}` });
        return;
      }
      if (s.type === 'airport') {
        let label = '✈';
        if (di === 0 && i === 0) label = '✈去';
        else if (di === lastDay && i === day.stops.length - 1) label = '✈回';
        out.push({ stops: [s], dayIdx: di, days: [di], type: 'airport', label, short: label });
        return;
      }
      // hotel
      const overnight = i === day.stops.length - 1 && di < lastDay;
      if (!overnight) {
        out.push({ stops: [s], dayIdx: di, days: [di], type: 'hotel', label: '住', short: '住' });
        return;
      }
      const night = di + 1;
      if (hotelGroup && hotelGroup.lastNight === night - 1 && samePlace(hotelGroup.stops[0], s)) {
        hotelGroup.stops.push(s); hotelGroup.days.push(di); hotelGroup.lastNight = night;
        hotelGroup.label = hotelGroup.short = `住${hotelGroup.firstNight}-${night}`;
      } else {
        hotelGroup = { stops: [s], dayIdx: di, days: [di], type: 'hotel', label: `住${night}`, short: `住${night}`, firstNight: night, lastNight: night };
        out.push(hotelGroup);
      }
    });
  });
  return out;
}

/** 行程清單中每個點的標籤（與地圖一致） */
export function stopLabelMap(plan) {
  const m = new Map();
  for (const g of buildTripMarkers(plan)) g.stops.forEach(s => m.set(s.id, g.label));
  return m;
}

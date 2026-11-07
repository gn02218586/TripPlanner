// 地圖：行程標記、備用庫灰色標記、參考規劃標記、路線、點擊新增與小視窗
import { lib } from './maps-loader.js';
import { MAP_ID } from '../config.js';
import {
  state, on, mutate, findStop, findBackup, TYPE_LABEL, DEFAULT_STAY, HOTEL_TAB_KIND,
  updateStop, moveStop, removeStop, stopToBackup, updateBackupItem, moveBackupItem,
  backupToTrip, addBackupItem,
} from './state.js';
import { buildTripMarkers, markerEl, dayColor, BACKUP_COLOR, REF_COLOR, TYPE_GLYPH } from './markers.js';
import { h, selectEl, confirmDialog, toast, samePlace } from './utils.js';
import { buildAddPanel, typeOptions, dayOptions, tabOptions, defaultDayIdx, confirmRemoveBackup } from './ui-common.js';

export async function createMapView(container, { getSchedule }) {
  const { Map, InfoWindow, Polyline } = await lib('maps');
  const { AdvancedMarkerElement } = await lib('marker');
  const { Place } = await lib('places');

  const b = state.project.bounds;
  const bounds = { north: b.n, south: b.s, east: b.e, west: b.w };
  const map = new Map(container, {
    mapId: MAP_ID,
    center: { lat: (b.n + b.s) / 2, lng: (b.e + b.w) / 2 }, zoom: 8,
    restriction: { latLngBounds: bounds, strictBounds: true },
    clickableIcons: true, gestureHandling: 'greedy',
    mapTypeControl: false, streetViewControl: false, fullscreenControl: false,
  });
  map.fitBounds(bounds, 0);

  const info = new InfoWindow();
  let tripMarkers = [], backupMarkers = [], refMarkers = [], lines = [], tempMarker = null;
  const offs = [];

  const latLngOf = (pos) => ({
    lat: typeof pos.lat === 'function' ? pos.lat() : pos.lat,
    lng: typeof pos.lng === 'function' ? pos.lng() : pos.lng,
  });

  function openPopup(content, pos) {
    info.close();
    info.setContent(content);
    info.setPosition(pos);
    info.open({ map });
  }
  info.addListener('closeclick', () => clearTemp());

  function clearTemp() { if (tempMarker) { tempMarker.map = null; tempMarker = null; } }

  // ---------- 行程標記 ----------
  function renderTrip() {
    tripMarkers.forEach(m => (m.map = null));
    tripMarkers = [];
    const n = state.plan.days.length;
    const sel = state.selectedDay;
    for (const g of buildTripMarkers(state.plan)) {
      const isSel = sel != null && g.days.includes(sel);
      const faded = sel != null && !isSel;
      const s0 = g.stops[0];
      const m = new AdvancedMarkerElement({
        map, position: { lat: s0.lat, lng: s0.lng },
        content: markerEl({ type: g.type, label: isSel ? g.short : g.label, color: dayColor(g.dayIdx, n), faded }),
        gmpDraggable: true, gmpClickable: true, title: s0.name, zIndex: isSel ? 1000 : faded ? 1 : 100,
      });
      m.addEventListener('gmp-click', () => openStopPopup(s0.id));
      // 拖動中不計算；放開後才更新位置（路線重算由 planner 以 debounce 處理）
      m.addListener('dragend', () => {
        const p = latLngOf(m.position);
        mutate(plan => g.stops.forEach(s => {
          const f = findStop(s.id, plan);
          if (f) { f.stop.lat = p.lat; f.stop.lng = p.lng; }
        }));
      });
      tripMarkers.push(m);
    }
  }

  // ---------- 路線 ----------
  function renderLines() {
    lines.forEach(l => l.setMap(null));
    lines = [];
    const sched = getSchedule();
    const n = state.plan.days.length;
    const sel = state.selectedDay;
    state.plan.days.forEach((day, di) => {
      const color = dayColor(di, n);
      const fade = sel != null && sel !== di;
      day.stops.forEach((s, i) => {
        const st = sched[di]?.stops[i];
        if (!st?.leg || !st.from) return;
        const mode = s.leg.mode;
        const inf = st.leg.info;
        const path = inf.status === 'ok' && inf.path?.length ? inf.path : [{ lat: st.from.lat, lng: st.from.lng }, { lat: s.lat, lng: s.lng }];
        const op = fade ? 0.2 : 0.9;
        const opts = { map, path, strokeColor: color, clickable: false, zIndex: fade ? 1 : 10 };
        if (mode === 'drive') Object.assign(opts, { strokeWeight: 4, strokeOpacity: op });
        else if (mode === 'transit') Object.assign(opts, {
          strokeOpacity: 0,
          icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: op, strokeColor: color, scale: 3 }, offset: '0', repeat: '14px' }],
        });
        else if (mode === 'walk') Object.assign(opts, {
          strokeOpacity: 0,
          icons: [{ icon: { path: google.maps.SymbolPath.CIRCLE, fillOpacity: op, fillColor: color, strokeOpacity: 0, scale: 2.5 }, offset: '0', repeat: '9px' }],
        });
        else Object.assign(opts, { strokeWeight: 1.5, strokeOpacity: op * 0.8 });
        lines.push(new Polyline(opts));
      });
    });
  }

  // ---------- 備用庫標記 ----------
  function renderBackup() {
    backupMarkers.forEach(m => (m.map = null));
    backupMarkers = [];
    const tabs = state.showAllBackup ? state.plan.backup.tabs : state.plan.backup.tabs.filter(t => t.id === state.activeTab);
    for (const tab of tabs) for (const it of tab.items) {
      const m = new AdvancedMarkerElement({
        map, position: { lat: it.lat, lng: it.lng },
        content: markerEl({ type: it.type, label: TYPE_GLYPH[it.type] || '', color: BACKUP_COLOR, small: true }),
        gmpClickable: true, title: it.name, zIndex: 0,
      });
      m.addEventListener('gmp-click', () => openBackupPopup(it.id));
      backupMarkers.push(m);
    }
  }

  // ---------- 參考規劃標記 ----------
  function renderRef() {
    refMarkers.forEach(m => (m.map = null));
    refMarkers = [];
    const ref = state.refPlan;
    if (!ref) return;
    for (const tab of ref.backup?.tabs || []) for (const it of tab.items) {
      const m = new AdvancedMarkerElement({
        map, position: { lat: it.lat, lng: it.lng },
        content: markerEl({ type: it.type, label: TYPE_GLYPH[it.type] || '', color: REF_COLOR, small: true }),
        gmpClickable: true, title: `${ref.name}：${it.name}`, zIndex: 0,
      });
      m.addEventListener('gmp-click', () => openRefPopup(it, tab));
      refMarkers.push(m);
    }
  }

  // ---------- 小視窗 ----------
  function openStopPopup(stopId) {
    const f = findStop(stopId);
    if (!f) return;
    const { stop, dayIdx, idx } = f;
    const nameIn = h('input', { type: 'text', value: stop.name, class: 'full', onChange: () => updateStop(stopId, { name: nameIn.value.trim() || '自訂地點' }) });
    const typeSel = selectEl(typeOptions(), stop.type, { onChange: () => {
      const t = typeSel.value;
      updateStop(stopId, { type: t, stayMin: t === 'hotel' ? 0 : (stop.stayMin || DEFAULT_STAY[t]) });
      openStopPopup(stopId);
    } });
    const daySel = selectEl(dayOptions(), dayIdx, { onChange: () => {
      const d = +daySel.value;
      moveStop(stopId, d, state.plan.days[d].stops.length);
      openStopPopup(stopId);
    } });
    const len = state.plan.days[dayIdx].stops.length;
    const posSel = selectEl(Array.from({ length: len }, (_, i) => ({ value: i, label: `第 ${i + 1} 站` })), idx, { onChange: () => {
      moveStop(stopId, dayIdx, +posSel.value); openStopPopup(stopId);
    } });
    const stayIn = h('input', { type: 'number', min: 0, step: 5, value: stop.stayMin ?? 0, class: 'num', onChange: () => updateStop(stopId, { stayMin: Math.max(0, +stayIn.value || 0) }) });
    const noteIn = h('textarea', { rows: 2, class: 'full', onChange: () => updateStop(stopId, { note: noteIn.value }) }, stop.note || '');
    const tabSel = selectEl(tabOptions(), state.activeTab);
    const content = h('div', { class: 'popup' },
      h('label', { class: 'row' }, '名稱', nameIn),
      h('label', { class: 'row' }, '類型', typeSel),
      h('div', { class: 'row' }, h('span', {}, '位置'), daySel, posSel),
      stop.type !== 'hotel' ? h('label', { class: 'row' }, '停留', stayIn, '分鐘') : h('div', { class: 'muted small' }, '住宿不計停留時間'),
      h('label', { class: 'row col' }, '備註', noteIn),
      h('div', { class: 'row' }, tabSel,
        h('button', { onClick: () => { stopToBackup(stopId, tabSel.value); info.close(); } }, '移回備用庫')),
      h('div', { class: 'row end' },
        h('button', { class: 'danger', onClick: async () => {
          if (await confirmDialog(`確定從行程刪除「${stop.name}」？`, '刪除', true)) { removeStop(stopId); info.close(); }
        } }, '刪除')),
    );
    openPopup(content, { lat: stop.lat, lng: stop.lng });
  }

  function openBackupPopup(itemId) {
    const f = findBackup(itemId);
    if (!f) return;
    const it = f.item;
    const nameIn = h('input', { type: 'text', value: it.name, class: 'full', onChange: () => updateBackupItem(itemId, { name: nameIn.value.trim() || '自訂地點' }) });
    const typeSel = selectEl(typeOptions(), it.type, { onChange: () => updateBackupItem(itemId, { type: typeSel.value, stayMin: DEFAULT_STAY[typeSel.value] }) });
    const stayIn = h('input', { type: 'number', min: 0, step: 5, value: it.stayMin ?? 0, class: 'num', onChange: () => updateBackupItem(itemId, { stayMin: Math.max(0, +stayIn.value || 0) }) });
    const noteIn = h('textarea', { rows: 2, class: 'full', onChange: () => updateBackupItem(itemId, { note: noteIn.value }) }, it.note || '');
    const daySel = selectEl(dayOptions(), defaultDayIdx());
    const tabSel = selectEl(tabOptions(), f.tab.id, { onChange: () => moveBackupItem(itemId, tabSel.value) });
    const content = h('div', { class: 'popup' },
      h('div', { class: 'muted small' }, `備用庫・${f.tab.name}${it.addedBy ? `・${it.addedBy} 加入` : ''}`),
      h('label', { class: 'row' }, '名稱', nameIn),
      h('label', { class: 'row' }, '類型', typeSel),
      h('label', { class: 'row' }, '停留', stayIn, '分鐘'),
      h('label', { class: 'row col' }, '備註', noteIn),
      h('label', { class: 'row' }, '頁簽', tabSel),
      h('div', { class: 'row' }, daySel,
        h('button', { class: 'primary', onClick: () => { backupToTrip(itemId, +daySel.value); info.close(); toast(`已加到 Day ${+daySel.value + 1}`, 'ok'); } }, '加到這天')),
      h('div', { class: 'row end' },
        h('button', { class: 'danger', onClick: async () => { if (await confirmRemoveBackup(itemId)) info.close(); } }, '刪除')),
    );
    openPopup(content, { lat: it.lat, lng: it.lng });
  }

  function openRefPopup(it, tab) {
    const exists = state.plan.backup.tabs.some(t => t.items.some(x => samePlace(x, it)));
    const tabSel = selectEl(tabOptions(), state.activeTab);
    const content = h('div', { class: 'popup' },
      h('div', { class: 'muted small' }, `參考：${state.refPlan?.name}・${tab.name}`),
      h('div', { class: 'popup-title' }, it.name),
      exists ? h('div', { class: 'tag' }, '已有')
        : h('div', { class: 'row' }, tabSel, h('button', { class: 'primary', onClick: () => {
          const target = state.plan.backup.tabs.find(t => t.id === tabSel.value);
          addBackupItem(tabSel.value, { ...it, type: target?.kind === HOTEL_TAB_KIND ? 'hotel' : it.type });
          info.close(); toast('已加入備用庫', 'ok');
        } }, '加到我的備用庫')),
    );
    openPopup(content, { lat: it.lat, lng: it.lng });
  }

  /** 新增地點小視窗（點地圖或搜尋） */
  function openAddPopup(pt) {
    clearTemp();
    tempMarker = new AdvancedMarkerElement({ map, position: { lat: pt.lat, lng: pt.lng }, content: markerEl({ type: 'spot', label: '＋', color: '#222' }) });
    openPopup(buildAddPanel(pt, { onDone: () => { info.close(); clearTemp(); } }), { lat: pt.lat, lng: pt.lng });
  }

  // ---------- 點地圖 ----------
  map.addListener('click', async (e) => {
    if (e.placeId) {
      e.stop(); // 不顯示 Google 預設資訊卡
      try {
        const place = new Place({ id: e.placeId, requestedLanguage: 'zh-TW' });
        await place.fetchFields({ fields: ['displayName', 'location'] });   // 只在點 POI 時取 displayName
        openAddPopup({ name: place.displayName || '自訂地點', placeId: e.placeId, ...latLngOf(place.location) });
      } catch (err) {
        console.warn(err);
        openAddPopup({ name: '自訂地點', placeId: null, ...latLngOf(e.latLng) });
      }
    } else if (e.latLng) {
      openAddPopup({ name: '自訂地點', placeId: null, ...latLngOf(e.latLng) });
    }
  });

  function renderAll() { renderTrip(); renderLines(); renderBackup(); renderRef(); }

  offs.push(on('plan', renderAll));
  offs.push(on('routes', renderLines));
  offs.push(on('select', () => { renderTrip(); renderLines(); }));
  offs.push(on('backupView', renderBackup));
  offs.push(on('refPlan', renderRef));
  renderAll();

  return {
    map,
    openAddPopup,
    focusStop(id) {
      const f = findStop(id); if (!f) return;
      map.panTo({ lat: f.stop.lat, lng: f.stop.lng });
      openStopPopup(id);
    },
    focusBackup(id) {
      const f = findBackup(id); if (!f) return;
      map.panTo({ lat: f.item.lat, lng: f.item.lng });
      openBackupPopup(id);
    },
    fitDay(di) {
      const pts = [];
      const day = state.plan.days[di];
      if (!day) return;
      const prev = di > 0 ? state.plan.days.slice(0, di).reverse().find(d => d.stops.length) : null;
      if (prev) pts.push(prev.stops[prev.stops.length - 1]);
      pts.push(...day.stops);
      if (!pts.length) return;
      const bb = new google.maps.LatLngBounds();
      pts.forEach(p => bb.extend({ lat: p.lat, lng: p.lng }));
      if (pts.length === 1) map.panTo(bb.getCenter()); else map.fitBounds(bb, 60);
    },
    destroy() { offs.forEach(f => f()); info.close(); },
  };
}

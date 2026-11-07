// 地圖：行程標記、備用庫灰色標記、參考規劃標記、路線、點擊新增與小視窗
import { lib } from './maps-loader.js';
import { MAP_ID } from '../config.js';
import {
  state, on, mutate, findStop, findBackup, prevPoint, selectStop, DEFAULT_STAY, HOTEL_TAB_KIND,
  updateStop, moveStop, removeStop, stopToBackup, updateBackupItem, moveBackupItem,
  backupToTrip, addBackupItem,
} from './state.js';
import { buildTripMarkers, markerEl, legTagEl, compareNodes, dayColor, BACKUP_COLOR, REF_COLOR, TYPE_GLYPH } from './markers.js';
import { compareInfo } from './compare.js';
import { h, selectEl, confirmDialog, toast, samePlace, fmtShortDur } from './utils.js';
import { buildAddPanel, typeOptions, dayOptions, tabOptions, dayAddRow, confirmRemoveBackup } from './ui-common.js';

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
  let tripMarkers = [], backupMarkers = [], refMarkers = [], lines = [], legTags = [], tempMarker = null;
  let hoverMarker = null, hoverLine = null, hoverBox = null;
  let popupFor = null; // 目前小視窗對應的資料 { kind:'stop'|'backup', id }，資料被刪除時自動關閉
  const offs = [];

  const latLngOf = (pos) => ({
    lat: typeof pos.lat === 'function' ? pos.lat() : pos.lat,
    lng: typeof pos.lng === 'function' ? pos.lng() : pos.lng,
  });

  function openPopup(content, pos, ref = null) {
    info.close();
    popupFor = ref;
    info.setContent(content);
    info.setPosition(pos);
    info.open({ map });
  }
  info.addListener('closeclick', () => { popupFor = null; clearTemp(); });

  /** 小視窗對應的行程點／備用點已不存在（移回備用庫、刪除、被別人改掉）就關閉 */
  function closeStalePopup() {
    if (!popupFor) return;
    const exists = popupFor.kind === 'stop' ? findStop(popupFor.id) : findBackup(popupFor.id);
    if (!exists) { info.close(); popupFor = null; }
  }

  function clearTemp() { if (tempMarker) { tempMarker.map = null; tempMarker = null; } }

  // ---------- 行程標記 ----------
  /** 依天篩選時要顯示的行程點：該天所有點＋該天起點（前一天最後一點） */
  function visibleStopIds() {
    const sel = state.selectedDay;
    if (sel == null || !state.plan.days[sel]) return null;
    const ids = new Set(state.plan.days[sel].stops.map(s => s.id));
    const origin = prevPoint(state.plan, sel, 0);
    if (origin) ids.add(origin.id);
    return ids;
  }

  function renderTrip() {
    tripMarkers.forEach(m => (m.map = null));
    tripMarkers = [];
    const n = state.plan.days.length;
    const visible = visibleStopIds();
    const allDays = state.selectedDay == null;
    const prevId = selectedLeg()?.from.id;   // 選取點的前一點：加外框
    for (const g of buildTripMarkers(state.plan)) {
      if (visible && !g.stops.some(s => visible.has(s.id))) continue;
      const s0 = g.stops[0];
      const withName = g.type !== 'airport';
      const selected = g.stops.some(s => s.id === state.selectedStop);
      const ring = !selected && g.stops.some(s => s.id === prevId);
      const m = new AdvancedMarkerElement({
        map, position: { lat: s0.lat, lng: s0.lng },
        // 「全部」顯示天-站（1-2）；單一天只顯示站號（2）；住宿、機場不變
        content: markerEl({ type: g.type, label: allDays ? g.label : g.short, name: withName ? s0.name : '', color: dayColor(g.dayIdx, n), selected, ring }),
        gmpDraggable: true, gmpClickable: true, title: s0.name, zIndex: selected ? 1000 : ring ? 900 : 100,
      });
      // 點標記＝選取（再點一次取消）；選取時開啟小視窗
      m.addEventListener('gmp-click', () => {
        const id = selected ? state.selectedStop : s0.id;
        selectStop(id);
        if (state.selectedStop) openStopPopup(state.selectedStop); else info.close();
      });
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
    legTags.forEach(m => (m.map = null));
    legTags = [];
    const sched = getSchedule();
    const n = state.plan.days.length;
    const sel = state.selectedDay;
    const hl = selectedLeg();   // 選取點的抵達路段
    state.plan.days.forEach((day, di) => {
      if (sel != null && sel !== di) return;   // 依天篩選：只畫該天路線
      const color = dayColor(di, n);
      day.stops.forEach((s, i) => {
        const st = sched[di]?.stops[i];
        if (!st?.leg || !st.from) return;
        const mode = s.leg.mode;
        const path = legPath(st, s);
        // 強調：選取的路段加粗、不透明、畫在上層；同一天其他路段變淡
        const emph = hl?.stopId === s.id;
        const fade = !!hl && !emph && hl.dayIdx === di;
        const op = emph ? 1 : fade ? 0.3 : 0.9;
        const k = emph ? 1.8 : 1;
        const opts = { map, path, strokeColor: color, clickable: false, zIndex: emph ? 40 : fade ? 5 : 10 };
        if (mode === 'drive') Object.assign(opts, { strokeWeight: 4 * k, strokeOpacity: op });
        else if (mode === 'transit') Object.assign(opts, {
          strokeOpacity: emph ? 0.25 : 0, strokeWeight: emph ? 8 : 1,
          icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: op, strokeColor: color, scale: 3 * k }, offset: '0', repeat: emph ? '18px' : '14px' }],
        });
        else if (mode === 'walk') Object.assign(opts, {
          strokeOpacity: emph ? 0.25 : 0, strokeWeight: emph ? 8 : 1,
          icons: [{ icon: { path: google.maps.SymbolPath.CIRCLE, fillOpacity: op, fillColor: color, strokeOpacity: 0, scale: 2.5 * k }, offset: '0', repeat: emph ? '12px' : '9px' }],
        });
        else Object.assign(opts, { strokeWeight: 1.5 * (emph ? 2 : 1), strokeOpacity: op * 0.8 });
        lines.push(new Polyline(opts));
        // 路段中間顯示採用的時間（含手動時間）
        if (st.leg.minutes != null) {
          legTags.push(new AdvancedMarkerElement({
            map, position: pathMidpoint(path),
            content: legTagEl(fmtShortDur(st.leg.minutes), color, { emph, fade }),
            zIndex: emph ? 2500 : fade ? 40 : 50,
          }));
        }
      });
    });
  }

  function legPath(st, s) {
    const inf = st.leg.info;
    return inf.status === 'ok' && inf.path?.length ? inf.path : [{ lat: st.from.lat, lng: st.from.lng }, { lat: s.lat, lng: s.lng }];
  }

  /** 選取點的抵達路段 { stopId, dayIdx, idx, from }；選的是起點（無前一段）或起點列時為 null */
  function selectedLeg() {
    if (!state.selectedStop || state.selectedStartOf != null) return null;
    const f = findStop(state.selectedStop);
    if (!f?.stop.leg) return null;
    const from = prevPoint(state.plan, f.dayIdx, f.idx);
    return from ? { stopId: f.stop.id, dayIdx: f.dayIdx, idx: f.idx, from } : null;
  }


  /** 沿路徑長度取中點 */
  function pathMidpoint(path) {
    if (path.length === 1) return path[0];
    const seg = [];
    let total = 0;
    for (let i = 1; i < path.length; i++) {
      const dx = (path[i].lng - path[i - 1].lng) * Math.cos(path[i].lat * Math.PI / 180);
      const dy = path[i].lat - path[i - 1].lat;
      const d = Math.hypot(dx, dy);
      seg.push(d); total += d;
    }
    let half = total / 2;
    for (let i = 0; i < seg.length; i++) {
      if (half <= seg[i] || i === seg.length - 1) {
        const r = seg[i] ? Math.min(1, half / seg[i]) : 0;
        const a = path[i], b = path[i + 1];
        return { lat: a.lat + (b.lat - a.lat) * r, lng: a.lng + (b.lng - a.lng) * r };
      }
      half -= seg[i];
    }
    return path[0];
  }

  // ---------- 備用庫標記 ----------
  function renderBackup() {
    backupMarkers.forEach(m => (m.map = null));
    backupMarkers = [];
    // 勾選「地圖顯示備用點」才顯示，且只顯示目前頁簽
    if (!state.showBackupOnMap) return;
    const tabs = state.plan.backup.tabs.filter(t => t.id === state.activeTab);
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

  // ---------- 滑鼠停留中的備用點（暫時標記＋與選取點的虛線） ----------
  function renderHover() {
    if (hoverMarker) { hoverMarker.map = null; hoverMarker = null; }
    if (hoverLine) { hoverLine.setMap(null); hoverLine = null; }
    if (hoverBox) { hoverBox.map = null; hoverBox = null; }
    const it = state.hoverBackup;
    if (!it) return;
    hoverMarker = new AdvancedMarkerElement({
      map, position: { lat: it.lat, lng: it.lng },
      content: markerEl({ type: it.type, label: TYPE_GLYPH[it.type] || '•', name: it.name, color: '#555' }), zIndex: 2000,
    });
    const c = compareInfo(it);
    if (!c) return;   // 沒有選取點：只顯示備用點位置
    // 比較路線：Google 實際路線（以開車為主），半透明虛線，與正式行程路線區分
    const path = c.path?.length ? c.path : null;
    if (path) {
      hoverLine = new Polyline({
        map, path, strokeColor: '#222', strokeOpacity: 0.15, strokeWeight: 6, clickable: false, zIndex: 20,
        icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.85, strokeColor: '#222', scale: 3 }, offset: '0', repeat: '12px' }],
      });
    }
    const mid = path ? pathMidpoint(path) : { lat: (c.sel.stop.lat + it.lat) / 2, lng: (c.sel.stop.lng + it.lng) / 2 };
    hoverBox = new AdvancedMarkerElement({
      map, position: mid, zIndex: 3000,
      content: h('div', { class: 'cmp-box' }, ...compareNodes(c)),
    });
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
    openPopup(content, { lat: stop.lat, lng: stop.lng }, { kind: 'stop', id: stopId });
  }

  function openBackupPopup(itemId) {
    const f = findBackup(itemId);
    if (!f) return;
    const it = f.item;
    const nameIn = h('input', { type: 'text', value: it.name, class: 'full', onChange: () => updateBackupItem(itemId, { name: nameIn.value.trim() || '自訂地點' }) });
    const typeSel = selectEl(typeOptions(), it.type, { onChange: () => updateBackupItem(itemId, { type: typeSel.value, stayMin: DEFAULT_STAY[typeSel.value] }) });
    const stayIn = h('input', { type: 'number', min: 0, step: 5, value: it.stayMin ?? 0, class: 'num', onChange: () => updateBackupItem(itemId, { stayMin: Math.max(0, +stayIn.value || 0) }) });
    const noteIn = h('textarea', { rows: 2, class: 'full', onChange: () => updateBackupItem(itemId, { note: noteIn.value }) }, it.note || '');
    const tabSel = selectEl(tabOptions(), f.tab.id, { onChange: () => moveBackupItem(itemId, tabSel.value) });
    const content = h('div', { class: 'popup' },
      h('div', { class: 'muted small' }, `備用庫・${f.tab.name}${it.addedBy ? `・${it.addedBy} 加入` : ''}`),
      h('label', { class: 'row' }, '名稱', nameIn),
      h('label', { class: 'row' }, '類型', typeSel),
      h('label', { class: 'row' }, '停留', stayIn, '分鐘'),
      h('label', { class: 'row col' }, '備註', noteIn),
      h('label', { class: 'row' }, '頁簽', tabSel),
      dayAddRow((d) => { backupToTrip(itemId, d); info.close(); toast(`已加到 Day ${d + 1}`, 'ok'); }),
      h('div', { class: 'row end' },
        h('button', { class: 'danger', onClick: async () => { if (await confirmRemoveBackup(itemId)) info.close(); } }, '刪除')),
    );
    openPopup(content, { lat: it.lat, lng: it.lng }, { kind: 'backup', id: itemId });
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

  // 每一層各自重繪，其中一層出錯也不會讓其他層（例如備用點）殘留舊標記
  const safe = (fn) => () => { try { fn(); } catch (e) { console.error(e); } };
  const renderAll = () => [closeStalePopup, renderTrip, renderLines, renderBackup, renderHover, renderRef].forEach(f => safe(f)());

  offs.push(on('plan', renderAll));
  offs.push(on('routes', () => { safe(renderLines)(); if (state.hoverBackup) safe(renderHover)(); }));
  offs.push(on('select', () => { safe(renderTrip)(); safe(renderLines)(); }));
  // 選取只做強調，不縮放、不移動地圖（維持使用者目前的畫面）
  offs.push(on('stopSelect', () => { safe(renderTrip)(); safe(renderLines)(); safe(renderHover)(); }));
  offs.push(on('backupView', safe(renderBackup)));
  offs.push(on('backupHover', safe(renderHover)));
  offs.push(on('refPlan', safe(renderRef)));
  renderAll();

  return {
    map,
    openAddPopup,
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

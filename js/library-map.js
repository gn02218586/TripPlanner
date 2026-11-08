// 專案備用庫編輯畫面的地圖：依頁簽類型配色顯示所有頁簽的點、選取強調（不縮放）、點地圖／POI 加入、標記小視窗編輯
import { lib } from './maps-loader.js?v=2026-11-08-2';
import { MAP_ID } from '../config.js?v=2026-11-08-2';
import { state, on } from './state.js?v=2026-11-08-2';
import { markerEl, LIB_COLORS, TYPE_GLYPH } from './markers.js?v=2026-11-08-2';
import {
  findLibItem, addLibItem, moveLibItem, updateLibItem, selectLibItem, libItemMatches,
} from './library.js?v=2026-11-08-2';
import { dayPicker, daysButton, lockControls } from './ui-common.js?v=2026-11-08-2';
import { h, selectEl, toast } from './utils.js?v=2026-11-08-2';

export async function createLibraryMap(container, { onRemove, getAddDays = () => [] }) {
  const { Map, InfoWindow } = await lib('maps');
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
  let markers = [], tempMarker = null, popupFor = null;
  const offs = [];

  const latLngOf = (pos) => ({
    lat: typeof pos.lat === 'function' ? pos.lat() : pos.lat,
    lng: typeof pos.lng === 'function' ? pos.lng() : pos.lng,
  });
  const tabOpts = () => state.library.tabs.map(t => ({ value: t.id, label: t.name }));
  const clearTemp = () => { if (tempMarker) { tempMarker.map = null; tempMarker = null; } };

  function openPopup(content, pos, ref = null) {
    info.close();
    popupFor = ref;
    info.setContent(content);
    info.setPosition(pos);
    info.open({ map });
  }
  info.addListener('closeclick', () => { popupFor = null; clearTemp(); });

  // ---------- 標記 ----------
  function render() {
    markers.forEach(m => (m.map = null));
    markers = [];
    if (popupFor && !findLibItem(popupFor)) { info.close(); popupFor = null; }
    // 只顯示符合天數篩選的點
    for (const tab of state.library.tabs) for (const it of tab.items.filter(x => libItemMatches(x))) {
      const selected = it.id === state.libSelected;
      const m = new AdvancedMarkerElement({
        map, position: { lat: it.lat, lng: it.lng },
        // 選取的點放大並顯示名稱；其他點滑鼠移上顯示名稱
        content: markerEl({ type: it.type, label: TYPE_GLYPH[it.type] || '', name: selected ? it.name : '', color: LIB_COLORS[tab.type], selected, small: !selected }),
        gmpClickable: true, title: `${tab.name}：${it.name}`, zIndex: selected ? 1000 : 10,
      });
      m.addEventListener('gmp-click', () => {
        if (state.libSelected !== it.id) selectLibItem(it.id);
        openItemPopup(it.id);
      });
      markers.push(m);
    }
  }

  /** 共用點小視窗：改名稱、頁簽、停留、備註、刪除 */
  function openItemPopup(itemId) {
    const f = findLibItem(itemId);
    if (!f) return;
    const it = f.item;
    const nameIn = h('input', { type: 'text', value: it.name, class: 'full', onChange: () => updateLibItem(itemId, { name: nameIn.value.trim() || '自訂地點' }) });
    const tabSel = selectEl(tabOpts(), f.tab.id, { onChange: () => { moveLibItem(itemId, tabSel.value); openItemPopup(itemId); } });
    const stayIn = h('input', { type: 'number', min: 0, step: 5, value: it.stayMin ?? 0, class: 'num', onChange: () => updateLibItem(itemId, { stayMin: Math.max(0, +stayIn.value || 0) }) });
    const noteIn = h('textarea', { rows: 2, class: 'full', onChange: () => updateLibItem(itemId, { note: noteIn.value }) }, it.note || '');
    const content = h('div', { class: 'popup' },
      h('div', { class: 'muted small' }, `專案備用庫${it.addedBy ? `・${it.addedBy} 加入` : ''}${it.query ? `・搜尋字：${it.query}` : ''}`),
      h('label', { class: 'row' }, '名稱', nameIn),
      h('label', { class: 'row' }, '頁簽', tabSel),
      it.type !== 'hotel' ? h('label', { class: 'row' }, '停留', stayIn, '分鐘') : h('div', { class: 'muted small' }, '住宿不計停留時間'),
      h('div', { class: 'row' }, h('span', {}, '適用'), daysButton(it.days, (d) => { updateLibItem(itemId, { days: d }); openItemPopup(itemId); })),
      h('label', { class: 'row col' }, '備註', noteIn),
      h('div', { class: 'row end' },
        h('button', { class: 'danger', onClick: async () => { if (await onRemove(itemId)) info.close(); } }, '刪除')),
    );
    lockControls(content, state.libRO);   // 鎖定：只能檢視
    openPopup(content, { lat: it.lat, lng: it.lng }, itemId);
  }

  /** 新增小視窗（點地圖或 POI）：名稱＋頁簽 */
  function openAddPopup(pt) {
    if (state.libRO) return;   // 鎖定：不能加入
    clearTemp();
    tempMarker = new AdvancedMarkerElement({ map, position: { lat: pt.lat, lng: pt.lng }, content: markerEl({ type: 'spot', label: '＋', color: '#222' }) });
    const nameIn = h('input', { type: 'text', value: pt.name || '自訂地點', class: 'full' });
    const tabSel = selectEl(tabOpts(), state.libTab);
    const picker = dayPicker(getAddDays());
    const content = h('div', { class: 'popup add-panel' },
      h('label', { class: 'row' }, '名稱', nameIn),
      h('div', { class: 'row small' }, h('span', { class: 'muted' }, '適用：'), picker.el),
      h('div', { class: 'row' }, tabSel, h('button', { class: 'primary', onClick: () => {
        const r = addLibItem(tabSel.value, { ...pt, name: nameIn.value.trim() || '自訂地點', days: picker.get() });
        if (!r) return;
        info.close(); clearTemp();
        if (!r.added) toast('專案備用庫已有這個地點', 'warn');
        else toast('已加入專案備用庫', 'ok');
        selectLibItem(r.id);
      } }, '加入')));
    openPopup(content, { lat: pt.lat, lng: pt.lng });
  }

  map.addListener('click', async (e) => {
    if (e.placeId) {
      e.stop();
      try {
        const place = new Place({ id: e.placeId, requestedLanguage: 'zh-TW' });
        await place.fetchFields({ fields: ['displayName', 'location'] });
        openAddPopup({ name: place.displayName || '自訂地點', placeId: e.placeId, ...latLngOf(place.location) });
      } catch (err) {
        console.warn(err);
        openAddPopup({ name: '自訂地點', placeId: null, ...latLngOf(e.latLng) });
      }
    } else if (e.latLng) {
      openAddPopup({ name: '自訂地點', placeId: null, ...latLngOf(e.latLng) });
    }
  });

  const safeRender = () => { try { render(); } catch (e) { console.error(e); } };
  offs.push(on('library', safeRender));
  offs.push(on('lock', () => { info.close(); clearTemp(); popupFor = null; }));
  offs.push(on('libSelect', safeRender));
  offs.push(on('libFilter', safeRender));   // 選取只做強調，不縮放、不移動地圖
  safeRender();

  return {
    map,
    openItemPopup,
    destroy() { offs.forEach(f => f()); info.close(); clearTemp(); markers.forEach(m => (m.map = null)); },
  };
}

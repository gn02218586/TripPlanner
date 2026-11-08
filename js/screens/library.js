// 專案備用庫編輯畫面：左地圖（所有頁簽的點，依頁簽類型配色）、右邊備用庫清單（與規劃畫面右下共用元件）
// 搜尋新增、天數篩選、加入時指定天、匯入；頁簽可新增、改名、刪除
import { lib } from '../maps-loader.js?v=2026-11-08-2';
import { state, on, emit } from '../state.js?v=2026-11-08-2';
import { startLibrarySession, endLibrarySession, hasUnsavedLibrary, saveLibraryNow, startLockWatch, stopLockWatch } from '../store.js?v=2026-11-08-2';
import { isAdmin } from '../accounts.js?v=2026-11-08-2';
import { findLibItem, addLibItem, selectLibItem, mutateLib, mergeIntoLibrary, libItemMatches } from '../library.js?v=2026-11-08-2';
import { dayPicker, dayTint, confirmRemoveLibItem } from '../ui-common.js?v=2026-11-08-2';
import { createLibraryMap } from '../library-map.js?v=2026-11-08-2';
import { createLibraryPanel } from '../library-panel.js?v=2026-11-08-2';
import { openLibraryImport } from '../import.js?v=2026-11-08-2';
import { topBar, lockBarText } from './common.js?v=2026-11-08-2';
import { setPresenceScreen } from '../presence.js?v=2026-11-08-2';
import { h, toast } from '../utils.js?v=2026-11-08-2';

export async function mountLibrary(app, project) {
  const offs = [];
  state.libSelected = null;
  state.libDayFilter = 'all';

  app.replaceChildren(h('div', { class: 'center-screen' }, h('div', { class: 'muted' }, '載入專案備用庫中…')));
  await startLibrarySession(project.id);
  startLockWatch(project.id);   // 專案被鎖定時一般帳號只能檢視
  setPresenceScreen({ kind: 'library', text: `${project.name}／專案備用庫`, projectName: project.name });

  // ---------- 版面（與規劃的地圖畫面一致：左地圖、右側清單） ----------
  const statusEl = h('span', { class: 'save-status' }, '已儲存');
  const banner = h('div', { class: 'banner hidden' });
  const lockBar = h('div', { class: 'lock-bar hidden' });
  const mapEl = h('div', { class: 'map' });
  const searchBox = h('div', { class: 'search-box' });
  const filterBar = h('div', { class: 'lib-dayfilter' });
  const addDaysBox = h('div', { class: 'row small lib-adddays' });
  let addPicker = null;
  const getAddDays = () => addPicker?.get() || [];
  const listEl = h('div', { class: 'backup lib-backup' });
  const editTools = h('div', { class: 'lib-edit-tools' }, searchBox, addDaysBox);   // 鎖定時隱藏
  const importBtn = h('button', { class: 'small-btn', onClick: openImportDialog }, '匯入');
  const side = h('div', { class: 'side lib-side' },
    h('div', { class: 'lib-toolbar' },
      editTools,
      h('div', { class: 'row small' }, h('span', { class: 'muted' }, '顯示：'), filterBar),
      h('div', { class: 'small muted' }, '這個專案的所有規劃共用這份備用庫；規劃畫面右下也可以直接編輯。')),
    listEl);
  const root = h('div', { class: 'planner' },
    topBar([
      h('a', { href: `#/p/${project.id}`, class: 'link-btn', title: '返回首頁（自動展開這個專案）' }, '← 返回'),
      h('span', { class: 'proj-name' }, project.name), h('span', { class: 'muted' }, '/'),
      h('strong', {}, '📦 專案備用庫'), statusEl,
    ], [
      importBtn,
    ]),
    lockBar,
    banner,
    h('div', { class: 'main' }, mapEl, side));
  app.replaceChildren(root);

  const mapView = await createLibraryMap(mapEl, { onRemove: confirmRemoveLibItem, getAddDays });
  const panel = createLibraryPanel(listEl, {
    filter: (it) => libItemMatches(it),
    selectedId: () => state.libSelected,
    onRowClick: (id) => selectLibItem(id),
    emptyHint: '這個頁簽還沒有地點；可用上方搜尋、點地圖，或按右上「匯入」',
  });

  // ---------- 天數篩選（全部、不限、D1…；顏色與每日顏色相同）與「加入時指定天」 ----------
  function renderFilter() {
    const f = state.libDayFilter;
    const chip = (v, label, title, color) => h('button', {
      class: 'chip day-chip' + (f === v ? ' active' : ''), title, style: color ? { '--c': color } : null,
      onClick: () => {
        if (state.libDayFilter === v) return;
        state.libDayFilter = v;
        renderFilter(); panel.render(); emit('libFilter');
      },
    }, label);
    filterBar.replaceChildren(
      chip('all', '全部', '顯示所有點'),
      chip('none', '不限', '只顯示沒有指定天的點'),
      ...Array.from({ length: project.numDays }, (_, i) => chip(i + 1, `D${i + 1}`, `只顯示標示 D${i + 1} 的點`, dayTint(i + 1, project.numDays))));
    // 加入時指定天：預設跟著篩選（篩選某一天＝那一天，其他＝不限）
    addPicker = dayPicker(typeof f === 'number' ? [f] : []);
    addDaysBox.replaceChildren(h('span', { class: 'muted' }, '加入時指定天：'), addPicker.el);
  }
  renderFilter();

  // ---------- 搜尋新增（PlaceAutocompleteElement，加到目前頁簽） ----------
  try {
    const { PlaceAutocompleteElement } = await lib('places');
    const b = project.bounds;
    const pac = new PlaceAutocompleteElement({
      locationRestriction: { north: b.n, south: b.s, east: b.e, west: b.w },
      requestedLanguage: 'zh-TW',
    });
    pac.setAttribute('placeholder', '搜尋地點，加到目前頁簽…');
    pac.addEventListener('gmp-select', async ({ placePrediction }) => {
      try {
        const name = placePrediction.mainText?.text || placePrediction.text?.text || '地點';
        const place = placePrediction.toPlace();
        await place.fetchFields({ fields: ['id', 'location'] });   // Essentials
        const pt = { name, placeId: place.id, lat: place.location.lat(), lng: place.location.lng() };
        const r = addLibItem(state.libTab, { ...pt, days: getAddDays() });
        if (!r) return;
        if (r.added) toast(`已加入「${name}」`, 'ok');
        else toast('備用庫已有這個地點', 'warn');
        mapView.map.panTo(pt);   // 只移動到新加入的點，不改縮放
        if (state.libSelected !== r.id) selectLibItem(r.id);
      } catch (e) { console.error(e); toast('加入失敗：' + e.message, 'error'); }
    });
    searchBox.append(pac);
  } catch (e) {
    searchBox.append(h('div', { class: 'error small' }, '搜尋元件載入失敗'));
  }

  /** 選取（清單或地圖）：選到別的頁簽的點時切換頁簽；清單捲到該列 */
  function onSelect() {
    const f = state.libSelected && findLibItem(state.libSelected);
    if (f && f.tab.id !== state.libTab) state.libTab = f.tab.id;
    panel.render();
    panel.body.querySelector('.lib-row.selected')?.scrollIntoView({ block: 'nearest' });
  }

  function openImportDialog() {
    if (state.libRO) return;
    openLibraryImport(project, {
      getLibrary: () => state.library,
      apply: (entries, mode, tabSpecs) => {
        let r = { added: 0, dup: 0, newTabs: 0 };
        mutateLib(l => { r = mergeIntoLibrary(l, entries, { mode, tabSpecs }); });
        return r;
      },
    });
  }

  // ---------- 存檔狀態與別人的修改 ----------
  const STATUS = { saved: '已儲存', dirty: '尚未儲存…', saving: '儲存中…', error: '存檔失敗', conflict: '有衝突' };
  offs.push(on('libSaveStatus', (s) => { statusEl.textContent = STATUS[s] || s; statusEl.dataset.s = s; }));
  offs.push(on('libRemoteChange', ({ who, apply }) => {
    banner.replaceChildren(
      h('span', {}, `「${who}」剛修改了備用庫，是否載入？（會捨棄你尚未儲存的變更）`),
      h('button', { class: 'primary', onClick: () => { apply(); banner.classList.add('hidden'); } }, '載入'),
      h('button', { onClick: () => banner.classList.add('hidden') }, '稍後'));
    banner.classList.remove('hidden');
  }));
  offs.push(on('library', () => { panel.render(); if (!hasUnsavedLibrary()) banner.classList.add('hidden'); }));
  offs.push(on('libSelect', onSelect));

  // ---------- 鎖定提示（頂部）與編輯工具 ----------
  function renderLock() {
    const text = lockBarText({ projectLocked: state.projectLocked, planLocked: false });
    lockBar.textContent = text || '';
    lockBar.classList.toggle('hidden', !text);
    lockBar.classList.toggle('admin', isAdmin());
    editTools.classList.toggle('hidden', !!state.libRO);
    importBtn.disabled = !!state.libRO;
  }
  renderLock();
  offs.push(on('lock', () => { renderLock(); panel.render(); }));

  const onKey = (e) => {
    if (e.key !== 'Escape' || !state.libSelected) return;
    if (e.target.closest?.('input,textarea,select') || document.querySelector('.modal-overlay')) return;
    selectLibItem(null);
  };
  document.addEventListener('keydown', onKey);
  const beforeUnload = (e) => { if (hasUnsavedLibrary()) { saveLibraryNow(); e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);

  panel.render();
  emit('libSaveStatus', 'saved');

  return async () => {
    window.removeEventListener('beforeunload', beforeUnload);
    document.removeEventListener('keydown', onKey);
    offs.forEach(f => f());
    panel.destroy();
    mapView.destroy();
    await endLibrarySession();
    stopLockWatch();
    state.library = null; state.libSelected = null;
  };
}

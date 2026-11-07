// 專案備用庫編輯畫面：左地圖（三個頁簽不同顏色）、右邊頁簽清單；搜尋新增、編輯停留／備註、刪除、拖拉排序與換頁簽、匯入
import { lib } from '../maps-loader.js';
import { state, on, emit } from '../state.js';
import { startLibrarySession, endLibrarySession, hasUnsavedLibrary, saveLibraryNow } from '../store.js';
import {
  findLibItem, addLibItem, moveLibItem, updateLibItem, removeLibItem, selectLibItem, mutateLib, mergeIntoLibrary,
} from '../library.js';
import { createLibraryMap } from '../library-map.js';
import { openLibraryImport } from '../import.js';
import { typeIcon, LIB_COLORS } from '../markers.js';
import { makeSortable } from '../dnd.js';
import { topBar } from './common.js';
import { h, toast, confirmDialog } from '../utils.js';

export async function mountLibrary(app, project) {
  const offs = [];
  let sortables = [];
  state.libSelected = null;
  state.libTab ||= 'spot';

  app.replaceChildren(h('div', { class: 'center-screen' }, h('div', { class: 'muted' }, '載入專案備用庫中…')));
  await startLibrarySession(project.id);

  // ---------- 版面（與規劃的地圖畫面一致：左地圖、右側清單） ----------
  const statusEl = h('span', { class: 'save-status' }, '已儲存');
  const banner = h('div', { class: 'banner hidden' });
  const mapEl = h('div', { class: 'map' });
  const searchBox = h('div', { class: 'search-box' });
  const head = h('div', { class: 'backup-head' });
  const body = h('div', { class: 'backup-body scroll' });
  const side = h('div', { class: 'side lib-side' },
    h('div', { class: 'lib-toolbar' },
      searchBox,
      h('div', { class: 'small muted' }, '這個專案的所有規劃共用。在規劃畫面右下切換「專案共用」即可拖進行程（複製）。')),
    h('div', { class: 'backup lib-backup' }, head, body));
  const root = h('div', { class: 'planner' },
    topBar([
      h('a', { href: `#/p/${project.id}`, class: 'link-btn', title: '返回首頁（自動展開這個專案）' }, '← 返回'),
      h('span', { class: 'proj-name' }, project.name), h('span', { class: 'muted' }, '/'),
      h('strong', {}, '📦 專案備用庫'), statusEl,
    ], [
      h('button', { class: 'small-btn', onClick: openImportDialog }, '匯入'),
    ]),
    banner,
    h('div', { class: 'main' }, mapEl, side));
  app.replaceChildren(root);

  const mapView = await createLibraryMap(mapEl, { onRemove: confirmRemove });

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
        const r = addLibItem(state.libTab, pt);
        if (r.added) toast(`已加入「${name}」`, 'ok');
        else toast('專案備用庫已有這個地點', 'warn');
        mapView.map.panTo(pt);   // 只移動到新加入的點，不改縮放
        if (state.libSelected !== r.id) selectLibItem(r.id);
      } catch (e) { console.error(e); toast('加入失敗：' + e.message, 'error'); }
    });
    searchBox.append(pac);
  } catch (e) {
    searchBox.append(h('div', { class: 'error small' }, '搜尋元件載入失敗'));
  }

  // ---------- 清單 ----------
  function render() {
    sortables.forEach(s => s.destroy());
    sortables = [];
    const tabs = state.library.tabs;
    const active = tabs.find(t => t.id === state.libTab) || tabs[0];
    state.libTab = active.id;

    head.replaceChildren(h('div', { class: 'tabs' }, ...tabs.map(t => {
      // 拖到別的頁簽按鈕上＝移到該頁簽
      const drop = h('ul', { class: 'tab-drop', dataset: { kind: 'libtab', tab: t.id } });
      if (t.id !== active.id) sortables.push(makeSortable(drop, { group: { name: 'lib', pull: false, put: true }, sort: false }));
      return h('div', {
        class: 'tab lib-tab' + (t.id === active.id ? ' active' : ''), style: { '--c': LIB_COLORS[t.id] },
        onClick: () => { if (state.libTab !== t.id) { state.libTab = t.id; render(); } },
      }, h('span', { class: 'tab-name' }, `${t.name}（${t.items.length}）`), drop);
    })));

    const ul = h('ul', { class: 'backup-list lib-list', dataset: { kind: 'lib', tab: active.id } },
      active.items.map(it => h('li', {
        class: 'bitem lib-row' + (it.id === state.libSelected ? ' selected' : ''), dataset: { id: it.id },
        title: '拖拉可排序，拖到上方頁簽可移過去',
        onClick: (e) => { if (!e.target.closest('input,button,textarea')) selectLibItem(it.id); },
      },
        typeIcon(it.type, LIB_COLORS[active.id]),
        h('a', { href: '#', class: 'bname', onClick: (e) => { e.preventDefault(); } }, it.name),
        it.type !== 'hotel'
          ? h('label', { class: 'lib-stay small' },
            h('input', { type: 'number', min: 0, step: 5, class: 'num', value: it.stayMin ?? 0,
              onChange: (e) => updateLibItem(it.id, { stayMin: Math.max(0, +e.target.value || 0) }) }), '分')
          : h('span', { class: 'small muted lib-stay' }, '住宿'),
        h('input', { type: 'text', class: 'lib-note' + (it.note?.startsWith('⚠') ? ' warn' : ''), value: it.note || '', placeholder: '備註',
          title: it.note || '備註（「⚠」開頭表示需確認）', onChange: (e) => updateLibItem(it.id, { note: e.target.value }) }),
        h('button', { class: 'icon-btn', title: '刪除', onClick: () => confirmRemove(it.id) }, '✕'))));
    sortables.push(makeSortable(ul, {
      group: { name: 'lib', pull: true, put: true },
      onEnd: (evt) => {
        const id = evt.item.dataset.id;
        const toK = evt.to.dataset.kind;
        const same = evt.from === evt.to && evt.oldIndex === evt.newIndex;
        setTimeout(() => {
          if (toK === 'libtab') moveLibItem(id, evt.to.dataset.tab);
          else if (!same) moveLibItem(id, state.libTab, evt.newIndex);
          else render();
        }, 0);
      },
    }));
    body.replaceChildren(ul);
    if (!active.items.length) body.append(h('div', { class: 'empty-hint' }, '這個頁簽還沒有地點；可用上方搜尋、點地圖，或按右上「匯入」'));
  }

  /** 選取（清單或地圖）：選到別的頁簽的點時切換頁簽；清單捲到該列 */
  function onSelect() {
    const f = state.libSelected && findLibItem(state.libSelected);
    if (f && f.tab.id !== state.libTab) state.libTab = f.tab.id;
    render();
    body.querySelector('.lib-row.selected')?.scrollIntoView({ block: 'nearest' });
  }

  async function confirmRemove(itemId) {
    const f = findLibItem(itemId); if (!f) return false;
    if (!(await confirmDialog(`確定從專案備用庫刪除「${f.item.name}」？\n（已排入各規劃行程的點不受影響）`, '刪除', true))) return false;
    removeLibItem(itemId);
    return true;
  }

  function openImportDialog() {
    openLibraryImport(project, {
      getLibrary: () => state.library,
      apply: (entries, mode) => {
        let r = { added: 0, dup: 0 };
        mutateLib(lib => { r = mergeIntoLibrary(lib, entries, mode); });
        return r;
      },
    });
  }

  // ---------- 存檔狀態與別人的修改 ----------
  const STATUS = { saved: '已儲存', dirty: '尚未儲存…', saving: '儲存中…', error: '存檔失敗', conflict: '有衝突' };
  offs.push(on('libSaveStatus', (s) => { statusEl.textContent = STATUS[s] || s; statusEl.dataset.s = s; }));
  offs.push(on('libRemoteChange', ({ who, apply }) => {
    banner.replaceChildren(
      h('span', {}, `「${who}」剛修改了專案備用庫，是否載入？（會捨棄你尚未儲存的變更）`),
      h('button', { class: 'primary', onClick: () => { apply(); banner.classList.add('hidden'); } }, '載入'),
      h('button', { onClick: () => banner.classList.add('hidden') }, '稍後'));
    banner.classList.remove('hidden');
  }));
  offs.push(on('library', () => { render(); if (!hasUnsavedLibrary()) banner.classList.add('hidden'); }));
  offs.push(on('libSelect', onSelect));

  const onKey = (e) => {
    if (e.key !== 'Escape' || !state.libSelected) return;
    if (e.target.closest?.('input,textarea,select') || document.querySelector('.modal-overlay')) return;
    selectLibItem(null);
  };
  document.addEventListener('keydown', onKey);
  const beforeUnload = (e) => { if (hasUnsavedLibrary()) { saveLibraryNow(); e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);

  render();
  emit('libSaveStatus', 'saved');

  return async () => {
    window.removeEventListener('beforeunload', beforeUnload);
    document.removeEventListener('keydown', onKey);
    offs.forEach(f => f());
    sortables.forEach(s => s.destroy());
    mapView.destroy();
    await endLibrarySession();
    state.library = null; state.libSelected = null;
  };
}

// 備用庫清單（規劃畫面右下與專案備用庫編輯畫面共用）
// 頁簽：新增（選類型）、雙擊改名、× 刪除；每一列：停留分鐘、天數、備註、刪除；拖拉排序、拖到別的頁簽、拖進行程（複製）
import { state, emit } from './state.js?v=2026-11-09-1';
import { LIB_TYPES, LIB_TYPE_LABEL, inferTabType, updateLibItem, addLibTab, renameLibTab, removeLibTab } from './library.js?v=2026-11-09-1';
import { typeIcon, LIB_COLORS } from './markers.js?v=2026-11-09-1';
import { h, selectEl, openModal, confirmDialog, toast } from './utils.js?v=2026-11-09-1';
import { daysButton, scheduledTags, confirmRemoveLibItem, lockControls } from './ui-common.js?v=2026-11-09-1';
import { makeSortable } from './dnd.js?v=2026-11-09-1';

/**
 * opts：
 * - filter(it)：要顯示的點（依天篩選、隱藏已排入等）
 * - tools()：第二列的工具（篩選切換、勾選框）
 * - headExtra()：頁簽列右側（例如收起按鈕）
 * - showScheduled：顯示「已排入 Dn」（規劃畫面）
 * - onNameClick(id)、onRowClick(id)、selectedId()
 * - onRowEnter(id, li)、onRowLeave()、beforeRender()（滑鼠停留比較用）
 * - emptyHint：頁簽沒有點時的提示
 */
export function createLibraryPanel(container, opts = {}) {
  let sortables = [];
  const head = h('div', { class: 'backup-head' });
  const body = h('div', { class: 'backup-body scroll' });
  container.replaceChildren(head, body);

  // 雙擊頁簽改名（掛在不會重建的 head 上，第一下點擊切換頁簽重繪後仍有效）
  head.addEventListener('dblclick', (e) => {
    const tabEl = e.target.closest('.tab');
    if (!tabEl || e.target.closest('.tab-x, .tab-rename')) return;
    if (state.libRO) return;   // 鎖定：不能改名
    const tab = state.library?.tabs.find(t => t.id === tabEl.dataset.tabId);
    const nameEl = tabEl.querySelector('.tab-name');
    if (tab && nameEl) { e.preventDefault(); startRename(tabEl, nameEl, tab); }
  });

  const filter = (it) => (opts.filter ? opts.filter(it) : true);
  const tabLabel = (t) => {
    const n = t.items.filter(filter).length;
    return n === t.items.length ? `${t.name}（${n}）` : `${t.name}（${n}/${t.items.length}）`;
  };

  function render() {
    opts.beforeRender?.();
    sortables.forEach(s => s.destroy());
    sortables = [];
    const lib = state.library;
    if (!lib) {
      head.replaceChildren(h('div', { class: 'tabs' }, ...(opts.headExtra?.() || [])));
      body.replaceChildren(h('div', { class: 'empty-hint' }, '備用庫載入中…'));
      return;
    }
    const tabs = lib.tabs;
    const active = tabs.find(t => t.id === state.libTab) || tabs[0];
    state.libTab = active.id;
    const ro = !!state.libRO;
    const canDelete = tabs.length > 1 && !ro;   // 至少保留一個頁簽；鎖定時不能刪除

    const tabBtns = tabs.map(t => {
      // 拖到別的頁簽按鈕上＝移到該頁簽
      const drop = h('ul', { class: 'tab-drop', dataset: { kind: 'tabdrop', tab: t.id } });
      if (t.id !== active.id) sortables.push(makeSortable(drop, { group: { name: 'tp', pull: false, put: true }, sort: false }));
      return h('div', {
        class: 'tab lib-tab' + (t.id === active.id ? ' active' : ''), dataset: { tabId: t.id }, style: { '--c': LIB_COLORS[t.type] },
        title: ro ? `${LIB_TYPE_LABEL[t.type]}頁簽` : `${LIB_TYPE_LABEL[t.type]}頁簽；雙擊可改名`,
        onClick: () => { if (state.libTab !== t.id) { state.libTab = t.id; render(); emit('backupView'); } },
      }, h('span', { class: 'tab-name' }, tabLabel(t)),
        canDelete ? h('button', { class: 'tab-x', title: '刪除頁簽', onClick: (e) => { e.stopPropagation(); deleteTab(t); } }, '×') : null,
        drop);
    });
    const tools = (opts.tools?.() || []).filter(Boolean);
    head.replaceChildren(
      h('div', { class: 'tabs' }, ...tabBtns,
        ro ? null : h('button', { class: 'icon-btn', title: '新增頁簽', onClick: addTabDialog }, '＋'),
        ...(opts.headExtra?.() || [])),
      tools.length ? h('div', { class: 'backup-tools' }, ...tools) : null);

    const shown = active.items.filter(filter);
    const sel = opts.selectedId?.();
    const ul = h('ul', { class: 'backup-list lib-list', dataset: { kind: 'backup', tab: active.id } },
      shown.map(it => h('li', {
        class: 'bitem lib-row' + (it.id === sel ? ' selected' : ''), dataset: { id: it.id },
        title: ro ? '已鎖定，只能檢視' : opts.showScheduled ? '拖到行程可加入（備用庫保留原點）；拖拉可排序，拖到上方頁簽可移過去' : '拖拉可排序，拖到上方頁簽可移過去',
        onClick: (e) => { if (!e.target.closest('input,button,textarea,a')) opts.onRowClick?.(it.id); },
        onMouseenter: opts.onRowEnter ? (e) => opts.onRowEnter(it.id, e.currentTarget) : null,
        onMouseleave: opts.onRowLeave ? () => opts.onRowLeave() : null,
      },
        typeIcon(it.type, LIB_COLORS[active.type]),
        h('a', { href: '#', class: 'bname', title: it.name, onClick: (e) => { e.preventDefault(); (opts.onNameClick || opts.onRowClick)?.(it.id); } }, it.name),
        it.type !== 'hotel'
          ? h('label', { class: 'lib-stay small', title: '停留分鐘' },
            h('input', { type: 'number', min: 0, step: 5, class: 'num', value: it.stayMin ?? 0,
              onChange: (e) => updateLibItem(it.id, { stayMin: Math.max(0, +e.target.value || 0) }) }), '分')
          : h('span', { class: 'small muted lib-stay' }, '住宿'),
        daysButton(it.days, (d) => updateLibItem(it.id, { days: d })),
        opts.showScheduled ? scheduledTags(it) : null,
        h('input', { type: 'text', class: 'lib-note' + (it.note?.startsWith('⚠') ? ' warn' : ''), value: it.note || '', placeholder: '備註',
          title: it.note || '備註（「⚠」開頭表示需確認）', onChange: (e) => updateLibItem(it.id, { note: e.target.value }) }),
        h('button', { class: 'icon-btn', title: '刪除', onClick: () => confirmRemoveLibItem(it.id) }, '✕'))));
    sortables.push(makeSortable(ul, {
      // 拖到行程＝複製（備用庫保留原點）；在備用庫之間＝移動
      group: { name: 'tp', pull: (to) => (to.el.dataset.kind === 'trip' ? 'clone' : true), put: true },
    }));
    body.replaceChildren(ul);
    lockControls(body, ro);   // 鎖定：停留、天數、備註、刪除都停用
    if (!active.items.length) body.append(h('div', { class: 'empty-hint' }, opts.emptyHint || '這個頁簽還沒有地點；可用搜尋、點地圖加入'));
    else if (!shown.length) body.append(h('div', { class: 'empty-hint' }, `沒有符合目前篩選的點（這個頁簽共 ${active.items.length} 個）`));
  }

  /** 新增頁簽：名稱＋類型（輸入名稱時依名稱預選類型，使用者改過類型後就不再自動改） */
  async function addTabDialog() {
    const nameIn = h('input', { type: 'text', class: 'full', placeholder: '例如：雨天備案', maxlength: 30 });
    const typeSel = selectEl(LIB_TYPES.map(t => ({ value: t, label: LIB_TYPE_LABEL[t] })), 'spot');
    let typeTouched = false;
    typeSel.addEventListener('change', () => { typeTouched = true; });
    nameIn.addEventListener('input', () => { if (!typeTouched) typeSel.value = inferTabType(nameIn.value); });
    const m = openModal({
      title: '新增頁簽',
      body: h('div', {}, h('label', { class: 'row col' }, '頁簽名稱', nameIn), h('label', { class: 'row' }, '類型', typeSel),
        h('div', { class: 'small muted' }, '頁簽裡的點都是這個類型（住宿類頁簽的點不計停留時間）。')),
      actions: [{ label: '取消', value: null }, { label: '新增', value: 'ok', class: 'primary' }],
    });
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.close('ok'); });
    setTimeout(() => nameIn.focus(), 30);
    if ((await m.result) !== 'ok') return;
    const name = nameIn.value.trim();
    if (!name) { toast('請輸入頁簽名稱', 'warn'); return; }
    if (state.library.tabs.some(t => t.name === name)) { toast('已有同名頁簽', 'warn'); return; }
    addLibTab(name, typeSel.value);
    emit('backupView');
  }

  /** 雙擊頁簽名稱直接改名：Enter 確認、Esc 取消（點到別處也視為確認） */
  function startRename(tabEl, nameEl, tab) {
    if (tabEl.querySelector('.tab-rename')) return;
    const input = h('input', { type: 'text', class: 'tab-rename', value: tab.name, maxlength: 30 });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (ok && name && name !== tab.name) {
        if (state.library.tabs.some(t => t.id !== tab.id && t.name === name)) { toast('已有同名頁簽', 'warn'); render(); return; }
        renameLibTab(tab.id, name);
      } else render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
    nameEl.replaceWith(input);
    input.focus(); input.select();
  }

  async function deleteTab(tab) {
    if (state.library.tabs.length <= 1) { toast('至少要保留一個頁簽', 'warn'); return; }
    const msg = tab.items.length
      ? `頁簽「${tab.name}」裡有 ${tab.items.length} 個點，刪除頁簽會一起刪除這些點（這個專案的所有規劃共用備用庫）。\n確定刪除？`
      : `確定刪除頁簽「${tab.name}」？`;
    if (!(await confirmDialog(msg, '刪除', true))) return;
    removeLibTab(tab.id);
    emit('backupView');
  }

  return {
    head, body, render,
    destroy() { opts.beforeRender?.(); sortables.forEach(s => s.destroy()); sortables = []; },
  };
}

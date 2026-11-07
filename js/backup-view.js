// 右下：備用庫（頁簽式，屬於目前規劃）＋「參考其他規劃」
import {
  state, on, emit, mutate, HOTEL_TAB_KIND, scheduledDays, addBackupItem, makeBackupItem,
  findBackup,
} from './state.js';
import { typeIcon, BACKUP_COLOR, REF_COLOR, compareNodes } from './markers.js';
import { h, selectEl, uid, confirmDialog, promptDialog, toast, samePlace, fmtDateTime } from './utils.js';
import { requestCompare, compareInfo } from './compare.js';
import { confirmRemoveBackup } from './ui-common.js';
import { makeSortable } from './dnd.js';
import { listPlans, getPlan } from './store.js';

export function createBackupView(container, { mapView, onToggleCollapse }) {
  const offs = [];
  let sortables = [];
  let refPanel = null;
  let collapsed = false;

  const head = h('div', { class: 'backup-head' });
  const body = h('div', { class: 'backup-body scroll' });
  container.replaceChildren(head, body);

  // 雙擊頁簽改名（掛在不會重建的 head 上，第一下點擊切換頁簽重繪後仍有效）
  head.addEventListener('dblclick', (e) => {
    const tabEl = e.target.closest('.tab');
    if (!tabEl || e.target.closest('.tab-x, .tab-rename')) return;
    const tab = state.plan.backup.tabs.find(t => t.id === tabEl.dataset.tabId);
    const nameEl = tabEl.querySelector('.tab-name');
    if (tab && nameEl) { e.preventDefault(); startRename(tabEl, nameEl, tab); }
  });

  const hasPlace =(it) => state.plan.backup.tabs.some(t => t.items.some(x => samePlace(x, it)));

  function render() {
    hoverEnd();   // 清單重建時一併清掉暫時標記，避免殘留
    sortables.forEach(s => s.destroy());
    sortables = [];
    const tabs = state.plan.backup.tabs;
    const active = tabs.find(t => t.id === state.activeTab) || tabs[0];
    state.activeTab = active.id;

    const canDelete = tabs.length > 1;   // 至少保留一個頁簽：最後一個不顯示 ×
    const tabBtns = tabs.map(t => {
      const drop = h('ul', { class: 'tab-drop', dataset: { kind: 'tabdrop', tab: t.id } });
      if (t.id !== active.id) sortables.push(makeSortable(drop, { group: { name: 'tp', pull: false, put: true }, sort: false }));
      const nameEl = h('span', { class: 'tab-name', title: '雙擊可改名' }, `${t.name}（${t.items.length}）`);
      const tabEl = h('div', {
        class: 'tab' + (t.id === active.id ? ' active' : ''), dataset: { tabId: t.id },
        onClick: () => { if (state.activeTab !== t.id) { state.activeTab = t.id; render(); emit('backupView'); } },
      }, nameEl,
        canDelete ? h('button', { class: 'tab-x', title: '刪除頁簽', onClick: (e) => { e.stopPropagation(); deleteTab(t); } }, '×') : null,
        drop);
      return tabEl;
    });

    head.replaceChildren(
      h('div', { class: 'tabs' }, ...tabBtns,
        h('button', { class: 'icon-btn', title: '新增頁簽', onClick: addTab }, '＋'),
        h('button', { class: 'collapse-btn', title: collapsed ? '展開備用庫' : '收起備用庫', onClick: () => {
          collapsed = !collapsed; onToggleCollapse(collapsed); render();
        } }, collapsed ? '▲ 展開' : '▼ 收起')),
      h('div', { class: 'backup-tools' },
        h('label', { class: 'small', title: '在地圖上以灰色小標記顯示目前頁簽的備用點' },
          h('input', { type: 'checkbox', checked: state.showBackupOnMap, onChange: (e) => { state.showBackupOnMap = e.target.checked; emit('backupView'); } }), '地圖顯示備用點'),
        h('button', { class: 'small-btn', onClick: openReference }, '參考其他規劃')),
    );

    const ul = h('ul', { class: 'backup-list', dataset: { kind: 'backup', tab: active.id } },
      active.items.map(it => {
        const days = scheduledDays(it);
        return h('li', {
          class: 'bitem', dataset: { id: it.id }, title: '拖到行程可加入（備用庫保留）',
          onMouseenter: (e) => hoverStart(it.id, e.currentTarget),
          onMouseleave: () => hoverEnd(),
        },
          typeIcon(it.type, BACKUP_COLOR),
          h('a', { href: '#', class: 'bname', onClick: (e) => { e.preventDefault(); mapView.focusBackup(it.id); } }, it.name),
          it.type !== 'hotel' ? h('span', { class: 'small muted' }, `${it.stayMin ?? 0} 分`) : null,
          days.length ? h('span', { class: 'tag' }, `已排入 ${days.map(d => 'D' + d).join('、')}`) : null,
          it.addedBy ? h('span', { class: 'small muted' }, it.addedBy) : null,
          h('button', { class: 'icon-btn', title: '刪除', onClick: () => confirmRemoveBackup(it.id) }, '✕'));
      }));
    sortables.push(makeSortable(ul, {
      // 拖到行程＝複製；在備用庫之間＝移動
      group: { name: 'tp', pull: (to) => (to.el.dataset.kind === 'trip' ? 'clone' : true), put: true },
    }));
    body.replaceChildren(ul);
    if (!active.items.length) body.append(h('div', { class: 'empty-hint' }, '這個頁簽還沒有地點；可從行程拖過來，或搜尋／點地圖加入'));
  }

  // ---------- 滑鼠停留 0.5 秒：地圖暫時顯示＋與選取的行程點比較 ----------
  const HOVER_DELAY = 500;
  let hoverTimer = null;
  let hoverRow = null;   // { id, li, box }

  function hoverStart(itemId, li) {
    hoverEnd();
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      const f = findBackup(itemId);
      if (!f) return;
      state.hoverBackup = { ...f.item };
      emit('backupHover');
      const box = h('div', { class: 'bcompare' });
      hoverRow = { id: itemId, li, box };
      li.append(box);
      requestCompare(f.item);
      renderCompare();
    }, HOVER_DELAY);   // 未滿 0.5 秒不查詢
  }

  function hoverEnd() {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    hoverRow?.box.remove();
    hoverRow = null;
    if (state.hoverBackup) { state.hoverBackup = null; emit('backupHover'); }
  }

  function renderCompare() {
    if (!hoverRow) return;
    const it = findBackup(hoverRow.id)?.item;
    const c = compareInfo(it);
    if (!c) { hoverRow.box.remove(); return; }   // 沒有選取點：只在地圖顯示位置
    hoverRow.box.replaceChildren(...compareNodes(c));
    if (!hoverRow.box.isConnected) hoverRow.li.append(hoverRow.box);
  }

  async function addTab() {
    const name = await promptDialog('新增頁簽', '', '頁簽名稱');
    if (!name) return;
    const id = uid();
    mutate(p => p.backup.tabs.push({ id, name, items: [] }));
    state.activeTab = id; render(); emit('backupView');
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
        mutate(p => { const t = p.backup.tabs.find(x => x.id === tab.id); if (t) t.name = name; });
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
    if (state.plan.backup.tabs.length <= 1) { toast('至少要保留一個頁簽', 'warn'); return; }
    if (tab.items.length && !(await confirmDialog(`頁簽「${tab.name}」裡有 ${tab.items.length} 個點，確定一起刪除？`, '刪除', true))) return;
    mutate(p => { p.backup.tabs = p.backup.tabs.filter(t => t.id !== tab.id); });
    emit('backupView');
  }

  // ---------- 參考其他規劃 ----------
  async function openReference() {
    if (refPanel) return;
    const plans = (await listPlans(state.project.id)).filter(p => p.id !== state.planId);
    if (!plans.length) { toast('這個專案沒有其他規劃可參考', 'warn'); return; }
    const sel = selectEl([{ value: '', label: '選擇規劃…' }, ...plans.map(p => ({ value: p.id, label: `${p.name}（${p.lastEditor || p.creator}・${fmtDateTime(p.updatedAt)}）` }))], '');
    const content = h('div', { class: 'ref-content scroll' });
    const close = () => { refPanel?.remove(); refPanel = null; state.refPlan = null; emit('refPlan'); };
    refPanel = h('div', { class: 'ref-panel' },
      h('div', { class: 'ref-head' },
        h('strong', { style: { color: REF_COLOR } }, '參考其他規劃（唯讀）'),
        h('button', { class: 'icon-btn', title: '關閉', onClick: close }, '✕')),
      sel, content);
    document.querySelector('.planner')?.append(refPanel);
    sel.addEventListener('change', async () => {
      if (!sel.value) { state.refPlan = null; emit('refPlan'); content.replaceChildren(); return; }
      const p = await getPlan(state.project.id, sel.value);
      state.refPlan = p ? { id: p.id, name: p.name, backup: p.backup || { tabs: [] } } : null;
      emit('refPlan');
      renderRef(content);
    });
  }

  function renderRef(content) {
    const ref = state.refPlan;
    if (!ref || !refPanel) return;
    const targetSel = selectEl(state.plan.backup.tabs.map(t => ({ value: t.id, label: t.name })), state.activeTab);
    content.replaceChildren(
      h('div', { class: 'row small' }, '單筆加入到：', targetSel),
      ...(ref.backup.tabs || []).map(tab => h('div', { class: 'ref-tab' },
        h('div', { class: 'ref-tab-head' }, h('strong', {}, `${tab.name}（${tab.items.length}）`),
          h('button', { class: 'small-btn', onClick: () => { copyTab(tab); renderRef(content); } }, '整個頁簽複製')),
        h('ul', {}, tab.items.map(it => h('li', { class: 'bitem' },
          typeIcon(it.type, REF_COLOR), h('span', { class: 'bname' }, it.name),
          hasPlace(it) ? h('span', { class: 'tag' }, '已有')
            : h('button', { class: 'small-btn', onClick: () => {
              const target = state.plan.backup.tabs.find(t => t.id === targetSel.value);
              addBackupItem(targetSel.value, { ...it, type: target?.kind === HOTEL_TAB_KIND ? 'hotel' : it.type });
              renderRef(content);
            } }, '加入')))))));
  }

  /** 整個頁簽複製：同名頁簽直接合併，重複地點略過 */
  function copyTab(src) {
    let added = 0, skipped = 0;
    mutate(p => {
      let tab = p.backup.tabs.find(t => t.name === src.name);
      if (!tab) { tab = { id: uid(), name: src.name, items: [] }; if (src.kind) tab.kind = src.kind; p.backup.tabs.push(tab); }
      for (const it of src.items) {
        if (p.backup.tabs.some(t => t.items.some(x => samePlace(x, it)))) { skipped++; continue; }
        tab.items.push({ ...makeBackupItem(it, tab), addedBy: it.addedBy || state.nickname });
        added++;
      }
    });
    toast(`已加入 ${added} 個點${skipped ? `，略過已有的 ${skipped} 個` : ''}`, 'ok');
  }

  offs.push(on('plan', () => { render(); if (refPanel) renderRef(refPanel.querySelector('.ref-content')); }));
  offs.push(on('routes', renderCompare));
  offs.push(on('stopSelect', () => {
    if (!hoverRow) return;
    const it = findBackup(hoverRow.id)?.item;
    if (it) requestCompare(it);
    renderCompare();
  }));
  render();

  return {
    destroy() { hoverEnd(); offs.forEach(f => f()); sortables.forEach(s => s.destroy()); refPanel?.remove(); refPanel = null; state.refPlan = null; },
  };
}

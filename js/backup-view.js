// 右下：備用庫（頁簽式，屬於目前規劃）＋「參考其他規劃」
import {
  state, on, emit, mutate, HOTEL_TAB_KIND, scheduledDays, addBackupItem, makeBackupItem,
} from './state.js';
import { typeIcon, BACKUP_COLOR, REF_COLOR } from './markers.js';
import { h, selectEl, uid, confirmDialog, promptDialog, toast, samePlace, fmtDateTime } from './utils.js';
import { confirmRemoveBackup } from './ui-common.js';
import { makeSortable } from './dnd.js';
import { listPlans, getPlan } from './store.js';

export function createBackupView(container, { mapView, onToggleCollapse }) {
  const offs = [];
  let sortables = [];
  let refPanel = null;

  const head = h('div', { class: 'backup-head' });
  const body = h('div', { class: 'backup-body scroll' });
  container.replaceChildren(head, body);

  const hasPlace = (it) => state.plan.backup.tabs.some(t => t.items.some(x => samePlace(x, it)));

  function render() {
    sortables.forEach(s => s.destroy());
    sortables = [];
    const tabs = state.plan.backup.tabs;
    const active = tabs.find(t => t.id === state.activeTab) || tabs[0];
    state.activeTab = active.id;

    const tabBtns = tabs.map(t => {
      const drop = h('ul', { class: 'tab-drop', dataset: { kind: 'tabdrop', tab: t.id } });
      if (t.id !== active.id) sortables.push(makeSortable(drop, { group: { name: 'tp', pull: false, put: true }, sort: false }));
      return h('div', { class: 'tab' + (t.id === active.id ? ' active' : ''), onClick: () => { state.activeTab = t.id; render(); emit('backupView'); } },
        h('span', {}, `${t.name}（${t.items.length}）`), drop);
    });

    head.replaceChildren(
      h('div', { class: 'tabs' }, ...tabBtns,
        h('button', { class: 'icon-btn', title: '新增頁簽', onClick: addTab }, '＋')),
      h('div', { class: 'backup-tools' },
        h('button', { class: 'icon-btn', title: '重新命名頁簽', onClick: () => renameTab(active) }, '✎'),
        h('button', { class: 'icon-btn', title: '刪除頁簽', onClick: () => deleteTab(active) }, '🗑'),
        h('label', { class: 'small', title: '地圖上顯示所有頁簽的備用點' },
          h('input', { type: 'checkbox', checked: state.showAllBackup, onChange: (e) => { state.showAllBackup = e.target.checked; emit('backupView'); } }), '地圖顯示全部頁簽'),
        h('button', { class: 'small-btn', onClick: openReference }, '參考其他規劃'),
        h('button', { class: 'icon-btn', title: '收起／展開備用庫', onClick: onToggleCollapse }, '▾')),
    );

    const ul = h('ul', { class: 'backup-list', dataset: { kind: 'backup', tab: active.id } },
      active.items.map(it => {
        const days = scheduledDays(it);
        return h('li', { class: 'bitem', dataset: { id: it.id }, title: '拖到行程可加入（備用庫保留）' },
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

  async function addTab() {
    const name = await promptDialog('新增頁簽', '', '頁簽名稱');
    if (!name) return;
    const id = uid();
    mutate(p => p.backup.tabs.push({ id, name, items: [] }));
    state.activeTab = id; render(); emit('backupView');
  }
  async function renameTab(tab) {
    const name = await promptDialog('重新命名頁簽', tab.name);
    if (!name || name === tab.name) return;
    mutate(p => { const t = p.backup.tabs.find(x => x.id === tab.id); if (t) t.name = name; });
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
  render();

  return {
    destroy() { offs.forEach(f => f()); sortables.forEach(s => s.destroy()); refPanel?.remove(); refPanel = null; state.refPlan = null; },
  };
}

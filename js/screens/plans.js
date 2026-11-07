// 規劃分支：在專案列表右側（窄螢幕在專案卡片下方）展開某專案底下的所有規劃
// 可開啟、複製成新規劃、刪除、開啟新規劃（空白或複製現有）、匯入行程
import { state, blankPlanData, normalizePlan } from '../state.js';
import { listPlans, getPlan, createPlan, deletePlan } from '../store.js';
import { h, selectEl, fmtDateTime, toast, openModal, confirmDialog, promptDialog, clone, uid } from '../utils.js';
import { openProjectForm } from './project-form.js';
import { openImport } from '../import.js';

/** 複製規劃的內容（點與備用點換新 id） */
async function copyPlanData(project, srcId) {
  const src = await getPlan(project.id, srcId);
  const data = { days: clone(src.days), backup: clone(src.backup) };
  data.days.forEach(d => d.stops.forEach(s => { s.id = uid(); }));
  data.backup.tabs.forEach(t => t.items.forEach(i => { i.id = uid(); }));
  normalizePlan(data, project);
  return data;
}

/** 開啟新規劃：空白或複製現有（沿用原本流程） */
async function newPlanDialog(project, plans) {
  const nameIn = h('input', { type: 'text', class: 'full', value: '', placeholder: `例如：${state.nickname} 的規劃` });
  const srcSel = selectEl([{ value: '', label: '從空白開始（只有預設起訖點與兩個備用頁簽）' },
    ...plans.map(p => ({ value: p.id, label: `複製「${p.name}」（含備用庫）` }))], '');
  const m = openModal({
    title: '開啟新規劃',
    body: h('div', {}, h('label', { class: 'row col' }, '規劃名稱', nameIn), h('label', { class: 'row col' }, '內容', srcSel)),
    actions: [{ label: '取消', value: null }, { label: '建立', value: 'ok', class: 'primary' }],
  });
  setTimeout(() => nameIn.focus(), 30);
  if ((await m.result) !== 'ok') return;
  const name = nameIn.value.trim() || (srcSel.value ? `${plans.find(p => p.id === srcSel.value)?.name} 的複本` : `${state.nickname} 的規劃`);
  try {
    const data = srcSel.value ? await copyPlanData(project, srcSel.value) : blankPlanData(project);
    const id = await createPlan(project.id, { name, ...data });
    location.hash = `#/p/${project.id}/${id}`;
  } catch (e) { toast('建立失敗：' + e.message, 'error'); }
}

/**
 * 建立分支區塊
 * 回傳 HTMLElement；資料非同步載入
 */
export function buildBranch(project) {
  const list = h('ul', { class: 'branch-list' }, h('li', { class: 'branch-item' }, h('div', { class: 'muted small branch-loading' }, '載入規劃中…')));
  const actions = h('div', { class: 'branch-actions' });
  const el = h('div', { class: 'branch' },
    h('div', { class: 'branch-scroll scroll' }, list));

  let plans = [];
  async function load() {
    try {
      plans = await listPlans(project.id);
      const items = plans.map(p => h('li', { class: 'branch-item' },
        h('div', { class: 'card plan-card', title: '開啟這份規劃', onClick: (e) => {
          if (e.target.closest('button')) return;
          location.hash = `#/p/${project.id}/${p.id}`;
        } },
          h('div', { class: 'plan-card-main' },
            h('div', { class: 'li-title' }, p.name),
            h('div', { class: 'small muted' }, `建立 ${p.creator || '—'}・最後修改 ${p.lastEditor || '—'}`),
            h('div', { class: 'small muted' }, fmtDateTime(p.updatedAt))),
          h('div', { class: 'plan-card-btns' },
            h('button', { class: 'small-btn', title: '複製成新規劃（含備用庫）', onClick: () => copyPlan(p) }, '複製'),
            h('button', { class: 'small-btn danger', title: '刪除規劃', onClick: () => removePlan(p) }, '刪除')))));
      list.replaceChildren(...(items.length ? items
        : [h('li', { class: 'branch-item' }, h('div', { class: 'muted small branch-loading' }, '還沒有規劃'))]),
        h('li', { class: 'branch-item branch-add' }, actions));
      actions.replaceChildren(
        h('button', { class: 'primary', onClick: () => newPlanDialog(project, plans) }, '＋ 開啟新規劃'),
        h('button', { onClick: () => openImport(project) }, '匯入行程'),
        h('button', { class: 'small-btn', onClick: () => openProjectForm({ project, onSaved: () => location.reload() }) }, '專案設定'));
    } catch (e) {
      list.replaceChildren(h('li', { class: 'branch-item' }, h('div', { class: 'error small' }, '讀取失敗：' + e.message)));
    }
  }

  async function copyPlan(p) {
    const name = await promptDialog('複製成新規劃', `${p.name} 的複本`);
    if (!name) return;
    try {
      const data = await copyPlanData(project, p.id);
      await createPlan(project.id, { name, ...data });
      toast(`已建立「${name}」`, 'ok');
      load();
    } catch (e) { toast('複製失敗：' + e.message, 'error'); }
  }

  async function removePlan(p) {
    if (!(await confirmDialog(`確定刪除規劃「${p.name}」？（含歷史紀錄，無法復原）`, '刪除', true))) return;
    try { await deletePlan(project.id, p.id); toast('已刪除'); load(); }
    catch (e) { toast('刪除失敗：' + e.message, 'error'); }
  }

  load();
  return el;
}

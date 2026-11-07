// 選規劃：列出該專案所有規劃，可開啟、開啟新規劃（空白或複製現有）、刪除
import { state, blankPlanData, normalizePlan } from '../state.js';
import { listPlans, getPlan, createPlan, deletePlan } from '../store.js';
import { h, selectEl, fmtDate, fmtDateTime, toast, openModal, confirmDialog, clone, uid } from '../utils.js';
import { topBar } from './common.js';
import { openProjectForm } from './project-form.js';

export async function mountPlans(app, project) {
  const list = h('div', { class: 'list' }, h('div', { class: 'muted' }, '載入中…'));
  let plans = [];
  const page = h('div', { class: 'page' },
    topBar([
      h('a', { href: '#/', class: 'link-btn' }, '← 專案列表'),
      h('strong', {}, project.name),
      h('span', { class: 'small muted' }, `${fmtDate(project.startDate)} 起 ${project.numDays} 天`),
    ]),
    h('div', { class: 'page-body' },
      h('div', { class: 'row' },
        h('button', { class: 'primary', onClick: newPlan }, '＋ 開啟新規劃'),
        h('button', { onClick: () => openProjectForm({ project, onSaved: () => location.reload() }) }, '專案設定')),
      list));
  app.replaceChildren(page);

  async function load() {
    try {
      plans = await listPlans(project.id);
      list.replaceChildren(...(plans.length ? plans.map(p => h('div', { class: 'card list-item row-item' },
        h('a', { href: `#/p/${project.id}/${p.id}`, class: 'grow' },
          h('div', { class: 'li-title' }, p.name),
          h('div', { class: 'small muted' }, `建立者 ${p.creator || '—'}・最後修改 ${p.lastEditor || '—'}・${fmtDateTime(p.updatedAt)}`)),
        h('button', { class: 'icon-btn', title: '刪除規劃', onClick: async () => {
          if (!(await confirmDialog(`確定刪除規劃「${p.name}」？（含歷史紀錄，無法復原）`, '刪除', true))) return;
          await deletePlan(project.id, p.id); toast('已刪除'); load();
        } }, '🗑')))
        : [h('div', { class: 'muted' }, '還沒有規劃，請按「開啟新規劃」。')]));
    } catch (e) { list.replaceChildren(h('div', { class: 'error' }, '讀取失敗：' + e.message)); }
  }

  async function newPlan() {
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
      let data;
      if (srcSel.value) {
        const src = await getPlan(project.id, srcSel.value);
        data = { days: clone(src.days), backup: clone(src.backup) };
        data.days.forEach(d => d.stops.forEach(s => { s.id = uid(); }));
        data.backup.tabs.forEach(t => t.items.forEach(i => { i.id = uid(); }));
        normalizePlan(data, project);
      } else {
        data = blankPlanData(project);
      }
      const id = await createPlan(project.id, { name, ...data });
      location.hash = `#/p/${project.id}/${id}`;
    } catch (e) { toast('建立失敗：' + e.message, 'error'); }
  }

  load();
  return () => {};
}

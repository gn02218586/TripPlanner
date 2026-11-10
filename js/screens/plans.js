// 規劃分支：在專案列表右側（窄螢幕在專案卡片下方）展開某專案底下的所有規劃
// 可開啟、複製成新規劃、刪除、開啟新規劃（空白或複製現有）、匯入行程
import { state, blankPlanData, normalizePlan, fitPlanToProject } from '../state.js?v=2026-11-10-1';
import { listPlans, getPlan, createPlan, deletePlan, getLibrary, listProjects, copyPlanToProject, migratePlanBackups, setPlanLocked } from '../store.js?v=2026-11-10-1';
import { isAdmin, accountLabel } from '../accounts.js?v=2026-11-10-1';
import { listAccounts, accountTitle } from '../admin.js?v=2026-11-10-1';
import { libraryCounts } from '../library.js?v=2026-11-10-1';
import { h, selectEl, fmtDateTime, toast, openModal, confirmDialog, promptDialog, clone, uid } from '../utils.js?v=2026-11-10-1';
import { openProjectForm } from './project-form.js?v=2026-11-10-1';
import { openImport } from '../import.js?v=2026-11-10-1';

/** 複製規劃的行程（點換新 id；備用庫是專案共用，不必複製） */
async function copyPlanData(project, srcId) {
  const src = await getPlan(project.id, srcId);
  const data = { days: clone(src.days) };
  data.days.forEach(d => d.stops.forEach(s => { s.id = uid(); }));
  normalizePlan(data, project);
  return data;
}

/** 開啟新規劃：空白或複製現有（沿用原本流程） */
async function newPlanDialog(project, plans) {
  const nameIn = h('input', { type: 'text', class: 'full', value: '', placeholder: `例如：${state.nickname} 的規劃` });
  const srcSel = selectEl([{ value: '', label: '從空白開始（只有預設起訖點）' },
    ...plans.map(p => ({ value: p.id, label: `複製「${p.name}」的行程` }))], '');
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
 * 管理員：複製規劃到其他專案（任何帳號的任何專案）
 * onSameProject：目標就是目前專案時，完成後重新載入分支
 */
async function copyToProjectDialog(srcProject, plan, onSameProject) {
  let projects;
  let accounts = [];
  try { [projects, accounts] = await Promise.all([listProjects(), listAccounts()]); } catch (e) { toast('讀取專案失敗：' + e.message, 'error'); return; }
  // 下拉選單依擁有帳號分組（未歸屬排最後）
  const groups = new Map();
  for (const p of projects) {
    const k = String(p.ownerEmail || '').toLowerCase();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const keys = [...groups.keys()].sort((a, b) => (!a) - (!b) || accountLabel(a).localeCompare(accountLabel(b)));
  const sel = h('select', { class: 'full' },
    h('option', { value: '' }, '選擇目標專案…'),
    // 分組標題：帳號名稱（備註）
    ...keys.map(k => h('optgroup', { label: k ? accountTitle(k, accounts) : '未歸屬' },
      ...groups.get(k).map(p => h('option', { value: p.id }, `${p.name}（${p.numDays} 天${p.id === srcProject.id ? '・目前專案' : ''}）`)))));
  const nameIn = h('input', { type: 'text', class: 'full', value: `${plan.name}（來自 ${srcProject.name}）` });
  const libCb = h('input', { type: 'checkbox', checked: true });
  const m = openModal({
    title: '複製規劃到其他專案',
    body: h('div', {},
      h('div', { class: 'small muted' }, `來源：${accountLabel(srcProject.ownerEmail) || '未歸屬'}／${srcProject.name}／${plan.name}`),
      h('label', { class: 'row col' }, '目標專案', sel),
      h('label', { class: 'row col' }, '新規劃名稱', nameIn),
      h('label', { class: 'row' }, libCb, '同時把來源專案的備用庫合併到目標專案（同名頁簽合併、重複地點略過）'),
      h('div', { class: 'small muted' }, '複製內容：所有天、行程點、交通方式、手動時間、出發時間與相關路線快取。歷史不複製；日期一律跟著目標專案。')),
    actions: [{ label: '取消', value: null }, { label: '下一步', value: 'ok', class: 'primary' }],
  });
  if ((await m.result) !== 'ok') return;
  const target = projects.find(p => p.id === sel.value);
  if (!target) { toast('請選擇目標專案', 'warn'); return; }
  const name = nameIn.value.trim() || plan.name;

  // 確認：天數不同時說明影響
  let src;
  try { src = await getPlan(srcProject.id, plan.id); } catch (e) { toast('讀取規劃失敗：' + e.message, 'error'); return; }
  const { moved } = fitPlanToProject(src, target);
  const srcDays = (src.days || []).length;
  const notes = [];
  if (srcDays !== target.numDays) {
    notes.push(`來源規劃 ${srcDays} 天、目標專案 ${target.numDays} 天。`);
    if (moved.length) notes.push(`第 ${moved.map(x => x.day).join('、')} 天的 ${moved.reduce((a, x) => a + x.count, 0)} 個行程點會移到目標專案的備用庫（標示 ${moved.map(x => 'D' + x.day).join('、')} → 不限）。`);
    if (libCb.checked && target.numDays < srcDays) notes.push(`合併的備用點標示的天超出目標天數時，會拿掉那些天（只剩超出的天時改為不限）。`);
    if (target.numDays > srcDays) notes.push(`目標專案多出的天會是空白。`);
  }
  const msg = `把規劃「${plan.name}」（${accountLabel(srcProject.ownerEmail) || '未歸屬'}／${srcProject.name}）複製到 ${accountLabel(target.ownerEmail) || '未歸屬'}／${target.name}？原規劃保留不變。`
    + (notes.length ? '\n\n' + notes.join('\n') : '')
    + (libCb.checked ? '\n\n同時把來源專案的備用庫合併到目標專案。' : '');
  if (!(await confirmDialog(msg, '複製'))) return;

  const progress = h('div', { class: 'copy-progress' }, '準備中…');
  const pm = openModal({ title: '複製規劃', body: progress, actions: [] });
  pm.el.closest('.modal-overlay').addEventListener('mousedown', (ev) => ev.stopImmediatePropagation(), true);
  pm.el.querySelector('.modal-head .icon-btn')?.remove();
  try {
    const r = await copyPlanToProject(srcProject.id, plan.id, target.id, { name, includeLibrary: libCb.checked }, (t) => { progress.textContent = t; });
    progress.replaceChildren(
      h('p', {}, h('strong', {}, '已複製'), `：「${name}」→ ${accountLabel(target.ownerEmail) || '未歸屬'}／${target.name}`),
      h('p', { class: 'small muted' }, [
        `路線快取 ${r.routes} 筆`,
        r.lib ? `備用庫新增 ${r.lib.added} 筆${r.lib.dup ? `、略過重複 ${r.lib.dup} 筆` : ''}` : null,
      ].filter(Boolean).join('；')),
      h('div', { class: 'row end' },
        h('button', { onClick: () => { pm.close(); if (target.id === srcProject.id) onSameProject?.(); } }, '關閉'),
        h('button', { class: 'primary', onClick: () => { pm.close(); location.hash = `#/p/${target.id}/${r.planId}`; } }, '開啟新規劃')));
  } catch (e) {
    console.error(e);
    progress.replaceChildren(
      h('p', { class: 'error' }, '複製失敗：' + e.message),
      h('p', { class: 'small' }, '如果目標專案已出現不完整的規劃，請刪除後重試。'),
      h('div', { class: 'row end' }, h('button', { class: 'primary', onClick: () => pm.close() }, '關閉')));
  }
}

/**
 * 建立分支區塊
 * 回傳 HTMLElement；資料非同步載入
 */
export function buildBranch(project, { onDeleted, onCopied } = {}) {
  const list = h('ul', { class: 'branch-list' }, h('li', { class: 'branch-item' }, h('div', { class: 'muted small branch-loading' }, '載入規劃中…')));
  const actions = h('div', { class: 'branch-actions' });
  const el = h('div', { class: 'branch' },
    h('div', { class: 'branch-scroll scroll' }, list));

  let plans = [];
  // 一般帳號：專案被鎖定時不能新增、複製、匯入、刪除規劃
  const admin = isAdmin();
  const projRO = !admin && !!project.locked;
  const RO_TIP = '已被管理員鎖定';
  async function load() {
    try {
      // 舊資料轉移：各規劃的本規劃備用點合併到專案備用庫（只做一次；失敗時保留舊資料）
      try {
        const r = await migratePlanBackups(project.id);
        if (r?.plans) toast(`已把 ${r.plans} 個規劃的備用點合併到專案備用庫`, 'ok', 6000);
      } catch (e) { console.warn('備用點轉移失敗', e); toast('舊的備用點合併失敗，下次開啟時會再試：' + e.message, 'warn', 6000); }
      const [list0, libData] = await Promise.all([listPlans(project.id), getLibrary(project.id).catch(e => { console.warn(e); return null; })]);
      plans = list0;
      // 規劃清單上方：專案備用庫節點（各頁簽點數，最多列 4 個頁簽）
      const counts = libraryCounts(libData);
      const countText = counts.slice(0, 4).map(c => `${c.name.replace(/^備用/, '') || c.name} ${c.count}`).join('・')
        + (counts.length > 4 ? `…等 ${counts.length} 個頁簽` : '');
      const libNode = h('li', { class: 'branch-item' },
        h('div', { class: 'card plan-card lib-card', title: '進入專案備用庫（這個專案的所有規劃共用）', onClick: () => {
          location.hash = `#/lib/${project.id}`;
        } },
          h('div', { class: 'plan-card-main' },
            h('div', { class: 'li-title' }, '📦 專案備用庫'),
            h('div', { class: 'small muted' }, libData ? countText : '讀取失敗'))));
      const items = plans.map(p => h('li', { class: 'branch-item' },
        h('div', { class: 'card plan-card' + (p.locked ? ' locked' : ''), title: p.locked ? '開啟這份規劃（已鎖定）' : '開啟這份規劃', onClick: (e) => {
          if (e.target.closest('button, label, input')) return;
          location.hash = `#/p/${project.id}/${p.id}`;
        } },
          h('div', { class: 'plan-card-main' },
            h('div', { class: 'li-title' }, p.locked ? h('span', { class: 'lock-icon', title: '已被管理員鎖定' }, '🔒') : null, p.name),
            h('div', { class: 'small muted' }, `建立 ${p.creator || '—'}・最後修改 ${p.lastEditor || '—'}`),
            h('div', { class: 'small muted' }, fmtDateTime(p.updatedAt))),
          h('div', { class: 'plan-card-btns' },
            admin ? lockToggle(p) : null,
            h('button', { class: 'small-btn', disabled: projRO, title: projRO ? RO_TIP : '在這個專案複製成新規劃（只複製行程；備用庫是專案共用）', onClick: () => copyPlan(p) }, '複製'),
            admin ? h('button', { class: 'small-btn', title: '管理員：複製到其他專案（任何帳號）', onClick: () => copyToProjectDialog(project, p, load) }, '複製到其他專案') : null,
            h('button', { class: 'small-btn danger', disabled: projRO || (!admin && p.locked), title: projRO || (!admin && p.locked) ? RO_TIP : '刪除規劃', onClick: () => removePlan(p) }, '刪除')))));
      list.replaceChildren(libNode, ...(items.length ? items
        : [h('li', { class: 'branch-item' }, h('div', { class: 'muted small branch-loading' }, '還沒有規劃'))]),
        h('li', { class: 'branch-item branch-add' }, actions));
      actions.replaceChildren(
        project.locked ? h('div', { class: 'small lock-note' }, admin ? '🔒 專案已鎖定（管理員可編輯）' : '🔒 專案已被管理員鎖定，只能檢視') : null,
        h('button', { class: 'primary', disabled: projRO, title: projRO ? RO_TIP : null, onClick: () => newPlanDialog(project, plans) }, '＋ 開啟新規劃'),
        h('button', { disabled: projRO, title: projRO ? RO_TIP : null, onClick: () => openImport(project, { onDone: load }) }, '匯入行程'),
        h('button', { class: 'small-btn', onClick: () => openProjectForm({ project, onSaved: () => location.reload(), onDeleted, onCopied }) }, '專案設定'));
    } catch (e) {
      list.replaceChildren(h('li', { class: 'branch-item' }, h('div', { class: 'error small' }, '讀取失敗：' + e.message)));
    }
  }

  /** 管理員：鎖定規劃開關（只改 locked，不影響正在編輯的版本號） */
  function lockToggle(p) {
    const cb = h('input', { type: 'checkbox', checked: !!p.locked, onChange: async () => {
      const v = cb.checked;
      try { await setPlanLocked(project.id, p.id, v); toast(v ? `已鎖定「${p.name}」` : `已解除鎖定「${p.name}」`, 'ok'); load(); }
      catch (e) { cb.checked = !v; toast('設定失敗：' + e.message, 'error'); }
    } });
    return h('label', { class: 'small lock-toggle', title: '管理員：鎖定後一般帳號只能檢視這個規劃' }, cb, '鎖定規劃');
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

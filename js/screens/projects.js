// 專案列表＋規劃分支圖：左側專案卡片，點選後右側（窄螢幕在卡片下方）展開該專案的規劃分支
import { listProjects } from '../store.js?v=2026-11-08-2';
import { h, fmtDate, fmtDateTime } from '../utils.js?v=2026-11-08-2';
import { openProjectForm } from './project-form.js?v=2026-11-08-2';
import { topBar } from './common.js?v=2026-11-08-2';
import { buildBranch } from './plans.js?v=2026-11-08-2';
import { openImportProject } from '../import.js?v=2026-11-08-2';
import { isAdmin, accountLabel, isAdminEmail } from '../accounts.js?v=2026-11-08-2';
import { listAccounts, ensureAccountsFromProjects, accountTitle, openRegisterDialog } from '../admin.js?v=2026-11-08-2';

const STUB_Y = 30;   // 分支連接線在第一張規劃卡片的高度（與 CSS 一致）

/** expandId：要自動展開的專案（例如從地圖畫面返回時） */
export async function mountProjects(app, expandId = null) {
  let projects = [];
  let accounts = [];   // 管理員：已登記帳號（沒有專案的帳號也顯示分組）
  let openId = expandId;
  const collapsedGroups = new Set();   // 管理員首頁收合中的群組（擁有帳號 Email，未歸屬為 ''）
  const mq = window.matchMedia('(max-width: 820px)');

  const listEl = h('div', { class: 'proj-list' }, h('div', { class: 'muted' }, '載入中…'));
  const branchCol = h('div', { class: 'branch-col' });
  const layout = h('div', { class: 'branch-layout' }, listEl, branchCol);
  const page = h('div', { class: 'page' },
    topBar([h('strong', {}, isAdmin() ? '所有專案（管理員）' : '專案與規劃')]),
    h('div', { class: 'page-body page-wide' },
      h('div', { class: 'row' },
        h('button', { class: 'primary', onClick: () => openProjectForm({ onSaved: (id) => { location.hash = `#/p/${id}`; } }) }, '＋ 新建專案'),
        isAdmin() ? h('button', { onClick: () => openRegisterDialog({ onDone: () => load() }), title: '登記一個新的帳號組（之後到 Firebase 建立登入帳號）' }, '＋ 新增帳號組') : null,
        h('button', { onClick: () => openImportProject(), title: '貼上「匯出成匯入格式」的文字，建立新的專案（含規劃與備用庫）' }, '匯入成新專案')),
      layout));
  app.replaceChildren(page);

  async function load() {
    try {
      projects = await listProjects();
      if (isAdmin()) {
        // 管理員：把現有專案的擁有帳號補登記（只補沒登記的），再讀帳號清單
        try {
          await ensureAccountsFromProjects(projects);
          accounts = await listAccounts({ force: true });
        } catch (e) { console.warn('讀取帳號清單失敗', e); accounts = []; }
      }
      if (openId && !projects.some(p => p.id === openId)) openId = null;
      if (!openId && projects.length === 1) openId = projects[0].id;   // 只有一個專案：自動展開
      syncUrl();
      render();
    } catch (e) {
      listEl.replaceChildren(h('div', { class: 'error' }, '讀取失敗：' + e.message));
    }
  }

  function syncUrl() {
    // 只改網址，不觸發畫面切換（replaceState 不會觸發 hashchange）
    history.replaceState(null, '', openId ? `#/p/${openId}` : '#/');
  }

  function toggle(id) {
    openId = openId === id ? null : id;   // 再點同一個收起；點別的切換
    syncUrl();
    render();
  }

  function render() {
    const narrow = mq.matches;
    if (!projects.length && !(isAdmin() && accounts.length)) {
      listEl.replaceChildren(h('div', { class: 'muted empty-hint' }, '目前沒有專案，點『新建專案』開始規劃'));
      branchCol.replaceChildren();
      layout.classList.remove('has-branch');
      return;
    }
    let branch = null, openCard = null;
    /** 建立一組專案卡片（窄螢幕時分支接在選取的卡片下方） */
    const buildCards = (list) => {
      const cards = [];
      for (const p of list) {
        const isOpen = p.id === openId;
        const card = h('div', { class: 'card list-item proj-card' + (isOpen ? ' open' : ''), title: isOpen ? '點選收起' : '點選展開規劃', onClick: () => toggle(p.id) },
          h('div', { class: 'li-title' }, p.locked ? h('span', { class: 'lock-icon', title: '已被管理員鎖定' }, '🔒') : null, p.name, h('span', { class: 'proj-caret' }, isOpen ? (narrow ? '▾' : '▸') : '')),
          h('div', { class: 'small muted' },
            `${fmtDate(p.startDate)} 起 ${p.numDays} 天・建立者 ${p.creatorNickname || '—'}・${fmtDateTime(p.createdAt)}`));
        cards.push(card);
        if (isOpen) {
          openCard = card;
          branch = buildBranch(p, {
            onDeleted: () => { openId = null; load(); },
            onCopied: (newId) => { openId = newId; load(); },   // 管理員複製完成：展開新專案（在目標帳號群組）
          });
          branch.classList.toggle('narrow', narrow);
          if (narrow) cards.push(branch);   // 窄螢幕：分支放在卡片下方
        }
      }
      return cards;
    };

    if (!isAdmin()) {
      listEl.replaceChildren(...buildCards(projects));
    } else {
      // 管理員：依擁有帳號分組；已登記但沒有專案的帳號也顯示；沒有擁有帳號的歸在「未歸屬」（排最後）
      const groups = new Map();
      for (const a of accounts) if (!isAdminEmail(a.email)) groups.set(a.email, []);
      for (const p of projects) {
        const key = String(p.ownerEmail || '').toLowerCase();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      }
      const keys = [...groups.keys()].sort((a, b) => (!a) - (!b) || accountLabel(a).localeCompare(accountLabel(b)));
      listEl.replaceChildren(...keys.map(key => {
        const list = groups.get(key);
        const hasOpen = list.some(p => p.id === openId);
        const isCollapsed = collapsedGroups.has(key) && !hasOpen;   // 含選取專案的群組一律展開
        const toggleBtn = h('button', { class: 'group-head', title: isCollapsed ? '展開' : '收合', onClick: () => {
          if (collapsedGroups.has(key)) collapsedGroups.delete(key);
          else { collapsedGroups.add(key); if (hasOpen) { openId = null; syncUrl(); } }
          render();
        } },
          h('span', { class: 'group-caret' }, isCollapsed ? '▸' : '▾'),
          // 分組標題：帳號名稱（備註）
          h('strong', {}, key ? accountTitle(key, accounts) : '未歸屬'),
          h('span', { class: 'small muted' }, `（${list.length} 個專案）`),
          key ? null : h('span', { class: 'small muted' }, '只有管理員看得到，請到專案設定指定擁有帳號'));
        // 分組旁：新建專案、匯入成新專案（擁有帳號直接設為這一組）
        const actions = key ? h('div', { class: 'group-actions' },
          h('button', { class: 'small-btn', title: `新建專案，擁有帳號：${key}`, onClick: () => openProjectForm({
            ownerEmail: key, onSaved: (id) => { location.hash = `#/p/${id}`; } }) }, '＋ 新建專案'),
          h('button', { class: 'small-btn', title: `匯入成新專案，擁有帳號：${key}`, onClick: () => openImportProject({ ownerEmail: key }) }, '匯入成新專案')) : null;
        return h('div', { class: 'proj-group' + (isCollapsed ? ' collapsed' : '') },
          h('div', { class: 'group-head-row' }, toggleBtn, actions),
          isCollapsed ? null : h('div', { class: 'proj-group-body' },
            ...(list.length ? buildCards(list) : [h('div', { class: 'muted small empty-group' }, '還沒有專案')])));
      }));
    }
    branchCol.replaceChildren(...(branch && !narrow ? [branch] : []));
    layout.classList.toggle('has-branch', !!branch && !narrow);
    positionBranch(openCard, branch, narrow);
  }

  /** 寬螢幕：讓分支的連接線對齊選取的專案卡片中央 */
  function positionBranch(card, branch, narrow) {
    if (!card || !branch || narrow) return;
    requestAnimationFrame(() => {
      const top = card.getBoundingClientRect().top + card.offsetHeight / 2 - branchCol.getBoundingClientRect().top - STUB_Y;
      branch.style.marginTop = Math.max(0, top) + 'px';
    });
  }

  const onResize = () => {
    const card = listEl.querySelector('.proj-card.open');
    positionBranch(card, branchCol.querySelector('.branch'), mq.matches);
  };
  const onMq = () => render();
  window.addEventListener('resize', onResize);
  mq.addEventListener('change', onMq);

  load();
  return () => {
    window.removeEventListener('resize', onResize);
    mq.removeEventListener('change', onMq);
  };
}

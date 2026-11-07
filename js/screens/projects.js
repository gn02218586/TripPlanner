// 專案列表＋規劃分支圖：左側專案卡片，點選後右側（窄螢幕在卡片下方）展開該專案的規劃分支
import { listProjects } from '../store.js';
import { runSeed } from '../seed.js';
import { h, fmtDate, fmtDateTime, toast } from '../utils.js';
import { openProjectForm } from './project-form.js';
import { topBar } from './common.js';
import { buildBranch } from './plans.js';
import { isAdmin, accountLabel } from '../accounts.js';

const STUB_Y = 30;   // 分支連接線在第一張規劃卡片的高度（與 CSS 一致）

/** expandId：要自動展開的專案（例如從地圖畫面返回時） */
export async function mountProjects(app, expandId = null) {
  let projects = [];
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
        h('button', { onClick: async () => {
          try { const id = await runSeed(); if (id) { openId = id; load(); } } catch (e) { toast('初始化失敗：' + e.message, 'error'); }
        } }, '初始化測試資料（北海道測試）')),
      layout));
  app.replaceChildren(page);

  async function load() {
    try {
      projects = await listProjects();
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
    if (!projects.length) {
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
          h('div', { class: 'li-title' }, p.name, h('span', { class: 'proj-caret' }, isOpen ? (narrow ? '▾' : '▸') : '')),
          h('div', { class: 'small muted' },
            `${fmtDate(p.startDate)} 起 ${p.numDays} 天・建立者 ${p.creatorNickname || '—'}・${fmtDateTime(p.createdAt)}`));
        cards.push(card);
        if (isOpen) {
          openCard = card;
          branch = buildBranch(p, { onDeleted: () => { openId = null; load(); } });
          branch.classList.toggle('narrow', narrow);
          if (narrow) cards.push(branch);   // 窄螢幕：分支放在卡片下方
        }
      }
      return cards;
    };

    if (!isAdmin()) {
      listEl.replaceChildren(...buildCards(projects));
    } else {
      // 管理員：依擁有帳號分組；沒有擁有帳號的歸在「未歸屬」（排最後）
      const groups = new Map();
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
        const head = h('button', { class: 'group-head', title: isCollapsed ? '展開' : '收合', onClick: () => {
          if (collapsedGroups.has(key)) collapsedGroups.delete(key);
          else { collapsedGroups.add(key); if (hasOpen) { openId = null; syncUrl(); } }
          render();
        } },
          h('span', { class: 'group-caret' }, isCollapsed ? '▸' : '▾'),
          h('strong', {}, key ? accountLabel(key) : '未歸屬'),
          h('span', { class: 'small muted' }, `（${list.length} 個專案）`),
          key ? null : h('span', { class: 'small muted' }, '只有管理員看得到，請到專案設定指定擁有帳號'));
        return h('div', { class: 'proj-group' + (isCollapsed ? ' collapsed' : '') }, head,
          isCollapsed ? null : h('div', { class: 'proj-group-body' }, ...buildCards(list)));
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

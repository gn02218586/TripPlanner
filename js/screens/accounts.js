// 帳號管理（只有管理員）：已登記帳號組的清單、備註、專案數量、最後上線、登記時間；登記與刪除登記
import { on } from '../state.js';
import { listProjects } from '../store.js';
import { isAdmin } from '../accounts.js';
import {
  listAccounts, ensureAccountsFromProjects, openRegisterDialog, updateAccountNote, deleteAccount, firebaseUsersButton,
} from '../admin.js';
import { lastSeenByEmail, startPresenceWatch, onlineCount, isOnline, presenceList } from '../presence.js';
import { topBar } from './common.js';
import { h, toast, openModal, fmtDateTime } from '../utils.js';

export async function mountAccounts(app) {
  const offs = [];
  const tableBox = h('div', { class: 'acct-box' }, h('div', { class: 'muted' }, '載入中…'));
  const page = h('div', { class: 'page' },
    topBar([h('a', { href: '#/', class: 'link-btn' }, '← 首頁'), h('strong', {}, '帳號管理')]),
    h('div', { class: 'page-body page-wide' },
      h('div', { class: 'row' },
        h('button', { class: 'primary', onClick: () => openRegisterDialog({ onDone: () => load() }) }, '＋ 新增帳號組'),
        firebaseUsersButton()),
      h('div', { class: 'small muted' },
        '這裡是網站上的帳號登記（帳號名稱與備註）。實際的登入帳號與密碼在 Firebase 的使用者頁面建立、停用或刪除。'),
      tableBox));
  app.replaceChildren(page);
  if (!isAdmin()) { tableBox.replaceChildren(h('div', { class: 'error' }, '只有管理員可以使用帳號管理')); return () => {}; }
  startPresenceWatch();

  let accounts = [], projects = [], loaded = false;
  async function load() {
    try {
      projects = await listProjects();
      // 首次開啟：把現有專案的擁有帳號補登記（不含管理員）
      const added = await ensureAccountsFromProjects(projects);
      if (added) toast(`已把 ${added} 個現有專案的擁有帳號補登記到清單`, 'ok');
      accounts = await listAccounts({ force: true });
      loaded = true;
      render();
    } catch (e) {
      tableBox.replaceChildren(h('div', { class: 'error' }, '讀取失敗：' + e.message));
    }
  }

  function render() {
    if (!accounts.length) {
      tableBox.replaceChildren(h('div', { class: 'muted empty-hint' }, '還沒有登記任何帳號組，按「＋ 新增帳號組」開始。'));
      return;
    }
    const counts = new Map();
    projects.forEach(p => { const e = String(p.ownerEmail || '').toLowerCase(); counts.set(e, (counts.get(e) || 0) + 1); });
    const seen = lastSeenByEmail();
    const now = Date.now();
    const onlineEmails = new Set(presenceList.filter(p => isOnline(p, now)).map(p => p.email));
    tableBox.replaceChildren(h('table', { class: 'acct-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, '帳號名稱'), h('th', {}, '備註'), h('th', {}, '專案'), h('th', {}, '最後上線'), h('th', {}, '登記時間'), h('th', {}, ''))),
      h('tbody', {}, accounts.map(a => {
        const noteIn = h('input', { type: 'text', class: 'full', value: a.note || '', placeholder: '例如：2028 日本團', maxlength: 60 });
        noteIn.addEventListener('change', async () => {
          try { await updateAccountNote(a.id, noteIn.value); toast('備註已儲存', 'ok'); }
          catch (e) { toast('儲存失敗：' + e.message, 'error'); }
        });
        const last = seen.get(a.email);
        return h('tr', {},
          h('td', {}, h('strong', {}, a.name || a.id), h('div', { class: 'small muted' }, a.email)),
          h('td', {}, noteIn),
          h('td', { class: 'num-cell' }, String(counts.get(a.email) || 0)),
          h('td', { class: 'small' }, onlineEmails.has(a.email) ? h('span', { class: 'tag online-tag' }, '線上')
            : last ? fmtDateTime(last) : h('span', { class: 'muted' }, '—')),
          h('td', { class: 'small muted' }, a.createdAt ? fmtDateTime(a.createdAt) : '—'),
          h('td', {}, h('button', { class: 'small-btn danger', onClick: () => remove(a) }, '刪除登記')));
      }))),
    h('div', { class: 'small muted' }, `共 ${accounts.length} 個帳號組；目前線上 ${onlineCount()} 個分頁。最後上線來自線上使用者紀錄（保留 7 天）。`));
  }

  /** 刪除登記：只刪網站上的登記；Firebase 的登入帳號要到 Firebase 停用或刪除 */
  async function remove(a) {
    const n = projects.filter(p => String(p.ownerEmail || '').toLowerCase() === a.email).length;
    const m = openModal({
      title: '刪除登記',
      body: h('div', {},
        h('p', {}, `確定刪除帳號組「${a.name || a.id}」${a.note ? `（${a.note}）` : ''}的登記？`),
        h('p', { class: 'warn' }, '這只會刪除網站上的登記，Firebase 的登入帳號請到 Firebase 停用或刪除。'),
        n ? h('p', { class: 'small' }, `這個帳號有 ${n} 個專案，專案不會被刪除；之後開啟首頁時會自動再補登記（備註為空）。`) : null,
        h('div', {}, firebaseUsersButton())),
      actions: [{ label: '取消', value: null }, { label: '刪除登記', value: 'ok', class: 'danger' }],
    });
    if ((await m.result) !== 'ok') return;
    try {
      await deleteAccount(a.id);
      accounts = accounts.filter(x => x.id !== a.id);
      toast('已刪除登記', 'ok');
      render();
    } catch (e) { toast('刪除失敗：' + e.message, 'error'); }
  }

  // 最後上線：線上名單變動時更新（備註輸入中不重繪，避免打斷輸入）
  offs.push(on('presence', () => { if (loaded && !tableBox.contains(document.activeElement)) render(); }));
  load();
  return () => { offs.forEach(f => f()); };
}

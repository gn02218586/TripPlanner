// 帳號管理（只有管理員）：已登記帳號組的清單、備註、專案數量、最後上線、登記時間；登記與刪除登記
import { on } from '../state.js?v=2026-11-08-2';
import { listProjects, updateProject, deleteProject } from '../store.js?v=2026-11-08-2';
import { isAdmin, isAdminEmail } from '../accounts.js?v=2026-11-08-2';
import {
  listAccounts, ensureAccountsFromProjects, openRegisterDialog, updateAccountNote, deleteAccount, firebaseUsersButton,
  accountPicker, accountTitle,
} from '../admin.js?v=2026-11-08-2';
import { lastSeenByEmail, startPresenceWatch, onlineCount, isOnline, presenceList } from '../presence.js?v=2026-11-08-2';
import { topBar } from './common.js?v=2026-11-08-2';
import { h, toast, openModal, fmtDateTime } from '../utils.js?v=2026-11-08-2';

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
          h('td', {}, isAdminEmail(a.email)
            ? h('button', { class: 'small-btn', disabled: true, title: '管理員帳號不能刪除' }, '刪除帳號組')
            : h('button', { class: 'small-btn danger', onClick: () => remove(a) }, '刪除帳號組')));
      }))),
    h('div', { class: 'small muted' }, `共 ${accounts.length} 個帳號組；目前線上 ${onlineCount()} 個裝置。最後上線來自線上使用者紀錄（保留 7 天）。`));
  }

  /**
   * 刪除帳號組：先處理這個帳號的專案（轉移或連同刪除），全部成功後才刪除登記（之後不會再被自動補登記）
   * Firebase 的登入帳號要到 Firebase 停用或刪除
   */
  async function remove(a) {
    if (isAdminEmail(a.email)) { toast('管理員帳號不能刪除', 'warn'); return; }
    const label = a.name || a.id;
    const owned = projects.filter(p => String(p.ownerEmail || '').toLowerCase() === a.email);
    const fbNote = () => h('div', { class: 'warn-box' },
      h('div', {}, 'Firebase 的登入帳號請到 Firebase 停用或刪除。'), firebaseUsersButton());

    if (!owned.length) {
      const m = openModal({
        title: '刪除帳號組',
        body: h('div', {},
          h('p', {}, `確定刪除帳號組「${label}」${a.note ? `（${a.note}）` : ''}？`),
          h('p', { class: 'small muted' }, '這個帳號沒有專案，只會刪除網站上的登記。'),
          fbNote()),
        actions: [{ label: '取消', value: null }, { label: '刪除帳號組', value: 'ok', class: 'danger' }],
      });
      if ((await m.result) !== 'ok') return;
      try { await deleteAccount(a.id); afterDeleted(a); } catch (e) { toast('刪除失敗：' + e.message, 'error'); }
      return;
    }

    // 還有專案：必須選擇處理方式
    let mode = null;
    const radio = (v, text) => h('label', { class: 'row' },
      h('input', { type: 'radio', name: 'acct-del-mode', value: v, onChange: () => { mode = v; sync(); } }), text);
    const picker = accountPicker({ value: '', allowNone: true, allowOther: false, exclude: [a.email] });
    const transferBox = h('div', { class: 'sub-box hidden' }, h('div', { class: 'small muted' }, '轉移給：'), picker.el);
    const confirmIn = h('input', { type: 'text', class: 'full', placeholder: label, autocapitalize: 'off', spellcheck: 'false' });
    const deleteBox = h('div', { class: 'sub-box hidden' },
      h('div', { class: 'small warn' }, `會刪除這 ${owned.length} 個專案的所有規劃、歷史紀錄、路線快取與專案備用庫，無法復原。`),
      h('label', { class: 'row col small' }, `請輸入帳號名稱「${label}」確認`, confirmIn));
    const okBtn = h('button', { class: 'danger', disabled: true, onClick: () => run() }, '刪除帳號組');
    const cancelBtn = h('button', { onClick: () => m.close() }, '取消');
    const progress = h('div', { class: 'copy-progress hidden' });
    const sync = () => {
      transferBox.classList.toggle('hidden', mode !== 'transfer');
      deleteBox.classList.toggle('hidden', mode !== 'delete');
      okBtn.disabled = !(mode === 'transfer' || (mode === 'delete' && confirmIn.value.trim().toLowerCase() === label.toLowerCase()));
    };
    confirmIn.addEventListener('input', sync);
    const form = h('div', {},
      h('p', {}, `帳號組「${label}」${a.note ? `（${a.note}）` : ''}還有 ${owned.length} 個專案：`),
      h('ul', { class: 'small proj-names' }, owned.map(p => h('li', {}, p.locked ? '🔒 ' : '', p.name || '（未命名）'))),
      h('div', {}, h('strong', {}, '請選擇這些專案的處理方式：')),
      radio('transfer', '轉移給其他帳號'), transferBox,
      radio('delete', '連同專案一起刪除'), deleteBox,
      fbNote(),
      h('div', { class: 'row end' }, cancelBtn, okBtn));
    const m = openModal({ title: '刪除帳號組', body: h('div', {}, form, progress), actions: [], wide: true });

    async function run() {
      const to = mode === 'transfer' ? picker.get() : null;
      if (mode === 'transfer' && to == null) { toast('請選擇要轉移給哪個帳號', 'warn'); return; }
      form.classList.add('hidden');
      progress.classList.remove('hidden');
      let done = 0;
      try {
        for (const p of owned) {
          const head = `${mode === 'transfer' ? '轉移' : '刪除'}專案 ${done + 1} / ${owned.length}「${p.name || ''}」`;
          progress.textContent = head + '…';
          if (mode === 'transfer') await updateProject(p.id, { ownerEmail: to });
          else await deleteProject(p.id, (t) => { progress.textContent = `${head}：${t}`; });
          done++;
        }
        progress.textContent = '刪除登記…';
        await deleteAccount(a.id);
        m.close();
        toast(mode === 'transfer'
          ? `已把 ${done} 個專案轉移給「${to ? accountTitle(to, accounts) : '未歸屬'}」，並刪除帳號組「${label}」`
          : `已刪除 ${done} 個專案與帳號組「${label}」`, 'ok', 6000);
        afterDeleted(a, true);
      } catch (e) {
        console.error(e);
        progress.replaceChildren(
          h('p', { class: 'error' }, `處理失敗：${e.message}`),
          h('p', { class: 'small' }, `已處理 ${done} / ${owned.length} 個專案；帳號組的登記保留，可以再試一次。`),
          h('div', { class: 'row end' }, h('button', { class: 'primary', onClick: () => { m.close(); load(); } }, '關閉')));
      }
    }
  }

  function afterDeleted(a, quiet = false) {
    accounts = accounts.filter(x => x.id !== a.id);
    if (!quiet) toast('已刪除帳號組', 'ok');
    load();
  }

  // 最後上線：線上名單變動時更新（備註輸入中不重繪，避免打斷輸入）
  offs.push(on('presence', () => { if (loaded && !tableBox.contains(document.activeElement)) render(); }));
  load();
  return () => { offs.forEach(f => f()); };
}

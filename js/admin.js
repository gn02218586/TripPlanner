// 管理員功能：帳號登記（accounts 集合）、登記表單、帳號選單、線上使用者名單
// 權限（firestore.rules）：accounts 只有管理員能讀寫；presence 只有管理員能讀
import { db, collection, doc, getDocs, updateDoc, deleteDoc, runTransaction, writeBatch } from './firebase.js?v=2026-11-10-1';
import { on } from './state.js?v=2026-11-10-1';
import {
  ACCOUNT_DOMAIN, ACCOUNT_NAME_RE, FIREBASE_USERS_URL, accountDocId, accountLabel, isAdmin, isAdminEmail, toEmail,
} from './accounts.js?v=2026-11-10-1';
import { presenceList, isOnline, onlineCount, cleanupOldPresence, startPresenceWatch, deviceGroups, KEEP_MS } from './presence.js?v=2026-11-10-1';
import { h, openModal, toast, copyText, fmtDateTime } from './utils.js?v=2026-11-10-1';

// =====================================================================
// 帳號登記資料：accounts/{帳號名稱}  { name, email, note, createdAt }
// =====================================================================
const accountsCol = () => collection(db, 'accounts');
let cache = null;   // 同一頁面內共用；登記、修改、刪除後更新

/** 已登記帳號（依帳號名稱排序） */
export async function listAccounts({ force = false } = {}) {
  if (!isAdmin()) return [];
  if (cache && !force) return cache;
  const snap = await getDocs(accountsCol());
  cache = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.id.localeCompare(b.id));
  return cache;
}
export const cachedAccounts = () => cache || [];

/** 顯示用：「帳號名稱（備註）」；沒有備註就只有帳號名稱 */
export function accountTitle(email, accounts = cachedAccounts()) {
  const e = String(email || '').toLowerCase();
  const a = accounts.find(x => x.email === e);
  return a?.note ? `${accountLabel(e)}（${a.note}）` : accountLabel(e);
}

/** 登記帳號組；帳號已登記時丟出 code 'exists' 的錯誤 */
export async function registerAccount(name, note = '') {
  const id = String(name || '').trim().toLowerCase();
  if (!ACCOUNT_NAME_RE.test(id)) throw new Error('帳號名稱只能用英文小寫、數字、連字號');
  const email = `${id}@${ACCOUNT_DOMAIN}`;
  if (isAdminEmail(email)) throw new Error('這是管理員帳號，不需要登記');
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'accounts', id);
    if ((await tx.get(ref)).exists()) { const e = new Error(`帳號「${id}」已登記`); e.code = 'exists'; throw e; }
    tx.set(ref, { name: id, email, note: String(note || '').trim(), createdAt: Date.now() });
  });
  cache = null;
  return email;
}

export async function updateAccountNote(id, note) {
  await updateDoc(doc(db, 'accounts', id), { note: String(note || '').trim() });
  const a = cache?.find(x => x.id === id);
  if (a) a.note = String(note || '').trim();
}

export async function deleteAccount(id) {
  const a = cache?.find(x => x.id === id);
  if (isAdminEmail(a?.email || '') || isAdminEmail(`${id}@${ACCOUNT_DOMAIN}`)) throw new Error('管理員帳號不能刪除');
  await deleteDoc(doc(db, 'accounts', id));
  if (cache) cache = cache.filter(x => x.id !== id);
}

/**
 * 把現有專案的擁有帳號（不含管理員）補登記進清單，備註留空；已登記的不動
 * 回傳補登記的筆數
 */
export async function ensureAccountsFromProjects(projects) {
  if (!isAdmin()) return 0;
  const accounts = await listAccounts();
  const have = new Set(accounts.map(a => a.id));
  const missing = [...new Set(projects.map(p => String(p.ownerEmail || '').toLowerCase()).filter(Boolean))]
    .filter(e => !isAdminEmail(e) && !have.has(accountDocId(e)));
  if (!missing.length) return 0;
  const batch = writeBatch(db);
  const now = Date.now();
  missing.forEach(e => batch.set(doc(db, 'accounts', accountDocId(e)), { name: accountDocId(e), email: e, note: '', createdAt: now }));
  await batch.commit();
  await listAccounts({ force: true });
  return missing.length;
}

// =====================================================================
// 登記表單與完成提示
// =====================================================================
/** 「＋ 新增帳號組」：登記表單 → 完成提示框；onDone(email) 在提示框關閉後呼叫 */
export async function openRegisterDialog({ onDone } = {}) {
  const nameIn = h('input', { type: 'text', class: 'full', placeholder: '例如：japan2028', maxlength: 40, autocapitalize: 'off', spellcheck: 'false' });
  const noteIn = h('input', { type: 'text', class: 'full', placeholder: '例如：2028 日本團', maxlength: 60 });
  const hint = h('div', { class: 'small muted' }, `只能用英文小寫、數字、連字號；登入 Email 會是「帳號名稱@${ACCOUNT_DOMAIN}」`);
  // 輸入時自動轉小寫並提示格式
  nameIn.addEventListener('input', () => {
    const v = nameIn.value.toLowerCase();
    if (v !== nameIn.value) nameIn.value = v;
    const bad = v && !ACCOUNT_NAME_RE.test(v);
    hint.className = 'small ' + (bad ? 'warn' : 'muted');
    hint.textContent = bad ? '只能用英文小寫、數字、連字號（不能有空白或其他符號）'
      : `登入 Email：${v || '帳號名稱'}@${ACCOUNT_DOMAIN}`;
  });
  const btn = h('button', { class: 'primary' }, '登記');
  const m = openModal({
    title: '新增帳號組',
    body: h('div', {},
      h('label', { class: 'row col' }, '帳號名稱', nameIn), hint,
      h('label', { class: 'row col' }, '備註', noteIn),
      h('div', { class: 'row end' }, h('button', { onClick: () => m.close() }, '取消'), btn)),
    actions: [],
  });
  setTimeout(() => nameIn.focus(), 30);
  btn.addEventListener('click', async () => {
    const name = nameIn.value.trim().toLowerCase();
    if (!name) { toast('請輸入帳號名稱', 'warn'); return; }
    if (!ACCOUNT_NAME_RE.test(name)) { toast('帳號名稱只能用英文小寫、數字、連字號', 'warn'); return; }
    btn.disabled = true; btn.textContent = '登記中…';
    try {
      const email = await registerAccount(name, noteIn.value);
      m.close('ok');
      await showRegisteredDialog(email);
      onDone?.(email);
    } catch (e) {
      toast(e.code === 'exists' ? e.message + '，請換一個名稱' : '登記失敗：' + e.message, 'warn', 5000);
      btn.disabled = false; btn.textContent = '登記';
    }
  });
}

/** 登記完成：提示到 Firebase 建立登入帳號 */
export function showRegisteredDialog(email) {
  return openModal({
    title: '已登記帳號組',
    body: h('div', { class: 'reg-done' },
      h('p', {}, h('strong', {}, '請到 Firebase 建立這個帳號並設定密碼')),
      h('div', { class: 'row' }, h('code', { class: 'reg-email' }, email), h('button', { class: 'small-btn', onClick: () => copyText(email) }, '複製')),
      h('div', {}, firebaseUsersButton()),
      h('ol', { class: 'small help' },
        h('li', {}, '點「新增使用者（Add user）」'),
        h('li', {}, '貼上上面的 Email'),
        h('li', {}, '設定密碼'),
        h('li', {}, '把帳號名稱（@ 前面那段）和密碼給旅伴'))),
    actions: [{ label: '關閉', value: null, class: 'primary' }],
  }).result;
}

export const firebaseUsersButton = (label = '開啟 Firebase 使用者頁面') =>
  h('a', { class: 'btn-link', href: FIREBASE_USERS_URL, target: '_blank', rel: 'noopener' }, label);

// =====================================================================
// 帳號選單（轉移專案、複製專案的目標帳號）
// =====================================================================
const OTHER = '__other__';
const NONE = '__none__';
/**
 * 已登記帳號的下拉選單＋「其他…」（手動輸入，沒有 @ 自動補網域）
 * value：預設的 Email；allowNone：多一個「未歸屬」選項
 * 回傳 { el, get() }：get() 回傳 Email（未歸屬＝''）；格式不正確回傳 null
 */
export function accountPicker({ value = '', allowNone = false, allowOther = true, exclude = [] } = {}) {
  const skip = new Set(exclude.map(e => String(e).toLowerCase()));
  const sel = h('select', { class: 'full' });
  const other = h('input', { type: 'text', class: 'full hidden', placeholder: `帳號名稱，例如 hokkaido（自動補 @${ACCOUNT_DOMAIN}）`, autocapitalize: 'off', spellcheck: 'false' });
  const el = h('div', { class: 'acct-picker' }, sel, other);
  const fill = (accounts) => {
    const v = String(value || '').toLowerCase();
    const opts = [];
    if (allowNone) opts.push(h('option', { value: NONE }, '未歸屬（只有管理員看得到）'));
    else opts.push(h('option', { value: '' }, '選擇帳號…'));
    accounts.filter(a => !skip.has(a.email)).forEach(a => opts.push(h('option', { value: a.email }, accountTitle(a.email, accounts))));
    if (allowOther) opts.push(h('option', { value: OTHER }, '其他…（手動輸入）'));
    sel.replaceChildren(...opts);
    if (!v) sel.value = allowNone ? NONE : '';
    else if (accounts.some(a => a.email === v && !skip.has(v))) sel.value = v;
    else if (allowOther) { sel.value = OTHER; other.value = accountLabel(v); }
    else sel.value = allowNone ? NONE : '';
    other.classList.toggle('hidden', sel.value !== OTHER);
  };
  sel.addEventListener('change', () => { other.classList.toggle('hidden', sel.value !== OTHER); if (sel.value === OTHER) other.focus(); });
  fill(cachedAccounts());
  listAccounts().then(fill).catch(e => console.warn('讀取帳號清單失敗', e));
  return {
    el,
    get() {
      if (sel.value === NONE) return '';
      if (sel.value === OTHER) {
        const e = toEmail(other.value);
        return e && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null;
      }
      return sel.value || null;
    },
  };
}

// =====================================================================
// 線上使用者
// =====================================================================
const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return '剛剛';
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
  return `${Math.floor(s / 86400)} 天前`;
};

/** 頂部列的「線上 N」按鈕（只有管理員）；按鈕離開畫面後自動取消監聽 */
export function onlineButton() {
  startPresenceWatch();
  const btn = h('button', { class: 'small-btn online-btn', title: '線上使用者（數字＝線上裝置數）', onClick: openOnlineDialog });
  const draw = () => { btn.textContent = `線上 ${onlineCount()}`; };
  draw();
  let seen = false;   // 曾經顯示在畫面上；之後不在畫面上（換畫面了）就取消監聽
  const off = on('presence', () => {
    if (btn.isConnected) { seen = true; draw(); } else if (seen) off();
  });
  return btn;
}

/** 線上使用者名單（即時更新；同一個帳號＋同一台裝置合併成一列，點開看各分頁）；開啟時順便清除 7 天以上的舊資料 */
export function openOnlineDialog() {
  const body = h('div', { class: 'online-list' });
  const m = openModal({ title: '線上使用者', body, wide: true });
  cleanupOldPresence().then(n => { if (n) toast(`已清除 ${n} 筆超過 7 天的上線紀錄`); }).catch(e => console.warn('清除舊上線紀錄失敗', e));
  const expanded = new Set();   // 展開的裝置（重繪時保留）

  /** 一台裝置一列：暱稱 — N 個分頁、最近活動的畫面、時間、瀏覽器；點開列出各分頁 */
  function deviceRows(g, { showAccount = false, online = true } = {}) {
    const open = expanded.has(g.key);
    const multi = g.tabs.length > 1;
    const row = h('tr', { class: 'dev-row' + (multi ? ' clickable' : ''), title: multi ? (open ? '點選收起' : '點選查看各分頁') : null,
      onClick: () => { if (!multi) return; if (open) expanded.delete(g.key); else expanded.add(g.key); render(); } },
      showAccount ? h('td', {}, accountTitle(g.email)) : null,
      h('td', {}, multi ? h('span', { class: 'dev-caret' }, open ? '▾ ' : '▸ ') : null,
        `${g.nickname || '—'} — ${g.tabs.length} 個分頁`, g.self ? h('span', { class: 'tag' }, '（你）') : null),
      h('td', {}, g.latest.screenText || '—'),
      h('td', { class: 'small muted' }, online ? ago(g.at) : `${fmtDateTime(g.at)}（${ago(g.at)}）`),
      h('td', { class: 'small muted' }, g.browser || ''));
    if (!open) return [row];
    return [row, ...g.tabs.map(t => h('tr', { class: 'tab-row' },
      showAccount ? h('td', {}) : null,
      h('td', { class: 'small' }, '　└ 分頁', t.self ? h('span', { class: 'tag' }, '（這個分頁）') : null),
      h('td', { class: 'small' }, t.screenText || '—'),
      h('td', { class: 'small muted' }, ago(t.at)),
      h('td', {})))];
  }

  function render() {
    const now = Date.now();
    const onlineTabs = presenceList.filter(p => isOnline(p, now));
    const online = deviceGroups(onlineTabs);
    const onlineKeys = new Set(online.map(g => g.key));
    // 最近 7 天：沒有任何線上分頁的裝置
    const recent = deviceGroups(presenceList.filter(p => !isOnline(p, now) && now - p.at < KEEP_MS)).filter(g => !onlineKeys.has(g.key));
    // 線上：依帳號分組
    const groups = new Map();
    for (const g of online) {
      if (!groups.has(g.email)) groups.set(g.email, []);
      groups.get(g.email).push(g);
    }
    body.replaceChildren(
      h('h4', {}, `線上（${online.length} 個裝置）`, h('span', { class: 'small muted' }, `　共 ${onlineTabs.length} 個分頁；最後活動在 3 分鐘內`)),
      groups.size ? h('div', {}, [...groups.entries()].map(([email, list]) => h('div', { class: 'online-group' },
        h('div', { class: 'online-head' }, h('strong', {}, accountTitle(email)), h('span', { class: 'small muted' }, `　${list.length} 個裝置`)),
        h('table', { class: 'online-table' }, list.flatMap(g => deviceRows(g)))))) : h('div', { class: 'muted small' }, '目前沒有人在線上'),
      h('h4', {}, `最近 7 天（${recent.length} 個裝置）`),
      recent.length ? h('table', { class: 'online-table' }, recent.flatMap(g => deviceRows(g, { showAccount: true, online: false })))
        : h('div', { class: 'muted small' }, '沒有其他紀錄'),
      h('div', { class: 'small muted' }, '同一個帳號在同一個瀏覽器開的分頁合併成一列（點選可展開）；分頁在前景時每 2 分鐘回報一次，切到背景時暫停。'));
  }
  render();
  listAccounts().then(render).catch(() => {});   // 帳號備註載入後重繪分組標題
  const off = on('presence', render);
  m.result.then(off);
}

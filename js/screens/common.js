// 各畫面共用：頂部列、暱稱（存在這台電腦的瀏覽器；沒填就顯示帳號名稱）
import { state, emit } from '../state.js?v=2026-11-09-1';
import { auth, signOut } from '../firebase.js?v=2026-11-09-1';
import { h, promptDialog } from '../utils.js?v=2026-11-09-1';
import { accountName, currentEmail, isAdmin } from '../accounts.js?v=2026-11-09-1';
import { stopPresence } from '../presence.js?v=2026-11-09-1';
import { onlineButton } from '../admin.js?v=2026-11-09-1';

const NICK_KEY = 'tripplanner.nickname';

export function loadNickname() {
  try { return localStorage.getItem(NICK_KEY) || ''; } catch { return ''; }
}
/** 儲存暱稱（空字串＝清除，改顯示帳號名稱） */
export function saveNickname(n) {
  try {
    if (n) localStorage.setItem(NICK_KEY, n); else localStorage.removeItem(NICK_KEY);
  } catch { /* 無法儲存時只在本次有效 */ }
  refreshNickname(n);
}

/** 目前顯示用的名稱：暱稱 → 帳號名稱 */
export function refreshNickname(stored = loadNickname()) {
  state.nickname = stored || accountName(currentEmail()) || '—';
  emit('nickname');
}

export async function changeNickname() {
  const v = await promptDialog('修改暱稱（留空＝顯示帳號名稱）', loadNickname(), accountName(currentEmail()));
  if (v !== null) saveNickname(v);
}

export function topBar(left = [], right = []) {
  const nickBtn = h('button', { class: 'link-btn', title: '修改暱稱', onClick: async () => { await changeNickname(); nickBtn.textContent = '👤 ' + state.nickname; } }, '👤 ' + state.nickname);
  const acct = accountName(currentEmail());
  return h('header', { class: 'topbar' },
    h('div', { class: 'tb-left' }, ...left),
    h('div', { class: 'tb-right' }, ...right, nickBtn,
      acct && acct !== state.nickname ? h('span', { class: 'small muted', title: currentEmail() }, acct) : null,
      isAdmin() ? h('span', { class: 'tag admin-tag' }, '管理員') : null,
      // 管理員：線上使用者、帳號管理
      isAdmin() ? onlineButton() : null,
      isAdmin() ? h('a', { class: 'small-btn btn-link', href: '#/accounts', title: '帳號登記、備註、最後上線' }, '帳號管理') : null,
      h('button', { class: 'link-btn', onClick: logout }, '登出')));
}

/** 登出：先刪除自己的線上狀態（規則需要登入中才能刪），再登出 */
async function logout() {
  try { await stopPresence(); } catch { /* 刪除失敗也照樣登出 */ }
  signOut(auth);
}

/**
 * 鎖定提示文字（畫面頂部）；沒有鎖定回傳空字串
 * - 管理員：「🔒 已鎖定（管理員可編輯）」
 * - 一般帳號：「🔒 已被管理員鎖定，只能檢視」（只鎖規劃時補充備用庫仍可編輯）
 */
export function lockBarText({ projectLocked, planLocked, libEditable = false }) {
  if (!projectLocked && !planLocked) return '';
  const what = projectLocked && planLocked ? '專案與規劃' : projectLocked ? '專案' : '規劃';
  if (isAdmin()) return `🔒 已鎖定（管理員可編輯）：${what}已被鎖定，一般帳號只能檢視`;
  return '🔒 已被管理員鎖定，只能檢視' + (!projectLocked && libEditable ? '（備用庫仍可編輯）' : '');
}

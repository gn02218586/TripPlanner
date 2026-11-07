// 各畫面共用：頂部列、暱稱（存在這台電腦的瀏覽器；沒填就顯示帳號名稱）
import { state, emit } from '../state.js';
import { auth, signOut } from '../firebase.js';
import { h, promptDialog } from '../utils.js';
import { accountName, currentEmail, isAdmin } from '../accounts.js';

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
      h('button', { class: 'link-btn', onClick: () => signOut(auth) }, '登出')));
}

// 各畫面共用：頂部列、暱稱
import { state, emit } from '../state.js';
import { auth, signOut } from '../firebase.js';
import { h, openModal, promptDialog } from '../utils.js';

const NICK_KEY = 'tripplanner.nickname';

export function loadNickname() {
  try { return localStorage.getItem(NICK_KEY) || ''; } catch { return ''; }
}
function saveNickname(n) {
  try { localStorage.setItem(NICK_KEY, n); } catch { /* 無法儲存時只在本次有效 */ }
  state.nickname = n;
  emit('nickname');
}

/** 第一次進站輸入暱稱 */
export async function ensureNickname() {
  state.nickname = loadNickname();
  while (!state.nickname) {
    const input = h('input', { type: 'text', class: 'full', placeholder: '例如：小明', maxlength: 20 });
    const m = openModal({
      title: '請輸入暱稱',
      body: h('div', {}, h('p', { class: 'muted' }, '用來記錄誰建立、誰修改了規劃（存在這台裝置的瀏覽器）。'), input),
      actions: [{ label: '確定', value: 'ok', class: 'primary' }],
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.close('ok'); });
    setTimeout(() => input.focus(), 30);
    await m.result;
    const v = input.value.trim();
    if (v) saveNickname(v);
  }
}

export async function changeNickname() {
  const v = await promptDialog('修改暱稱', state.nickname);
  if (v) saveNickname(v);
}

export function topBar(left = [], right = []) {
  const nickBtn = h('button', { class: 'link-btn', title: '修改暱稱', onClick: async () => { await changeNickname(); nickBtn.textContent = '👤 ' + state.nickname; } }, '👤 ' + state.nickname);
  return h('header', { class: 'topbar' },
    h('div', { class: 'tb-left' }, ...left),
    h('div', { class: 'tb-right' }, ...right, nickBtn,
      h('button', { class: 'link-btn', onClick: () => signOut(auth) }, '登出')));
}

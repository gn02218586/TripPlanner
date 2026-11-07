// 登入畫面（Firebase Email/密碼，大家共用一組帳號）
import { auth, signInWithEmailAndPassword } from '../firebase.js';
import { h } from '../utils.js';

const ERR = {
  'auth/invalid-credential': '帳號或密碼錯誤',
  'auth/invalid-email': 'Email 格式不正確',
  'auth/too-many-requests': '嘗試次數過多，請稍後再試',
  'auth/network-request-failed': '網路連線失敗',
};

export function mountLogin(app) {
  const email = h('input', { type: 'email', placeholder: 'Email', autocomplete: 'username', class: 'full' });
  const pw = h('input', { type: 'password', placeholder: '密碼', autocomplete: 'current-password', class: 'full' });
  const msg = h('div', { class: 'error small' });
  const btn = h('button', { class: 'primary full', type: 'submit' }, '登入');
  const form = h('form', { class: 'card login-card', onSubmit: async (e) => {
    e.preventDefault();
    msg.textContent = ''; btn.disabled = true; btn.textContent = '登入中…';
    try { await signInWithEmailAndPassword(auth, email.value.trim(), pw.value); }
    catch (err) { msg.textContent = ERR[err.code] || ('登入失敗：' + err.message); btn.disabled = false; btn.textContent = '登入'; }
  } },
    h('h1', {}, '行程規劃地圖'),
    h('p', { class: 'muted' }, '請用共用帳號登入'),
    email, pw, msg, btn);
  app.replaceChildren(h('div', { class: 'center-screen' }, form));
  setTimeout(() => email.focus(), 50);
  return () => {};
}

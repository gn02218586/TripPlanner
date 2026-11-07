// 登入畫面：帳號（沒有 @ 自動補 @tripplanner.app）、密碼、選填暱稱（存在這台電腦的瀏覽器）
import { auth, signInWithEmailAndPassword } from '../firebase.js';
import { h } from '../utils.js';
import { toEmail, ACCOUNT_DOMAIN } from '../accounts.js';
import { loadNickname, saveNickname } from './common.js';

const ERR = {
  'auth/invalid-credential': '帳號或密碼錯誤',
  'auth/invalid-email': '帳號格式不正確',
  'auth/user-disabled': '這個帳號已停用',
  'auth/too-many-requests': '嘗試次數過多，請稍後再試',
  'auth/network-request-failed': '網路連線失敗',
};

export function mountLogin(app) {
  const account = h('input', { type: 'text', placeholder: '帳號', autocomplete: 'username', class: 'full',
    autocapitalize: 'off', spellcheck: 'false' });
  const pw = h('input', { type: 'password', placeholder: '密碼', autocomplete: 'current-password', class: 'full' });
  const nick = h('input', { type: 'text', placeholder: '暱稱（選填）', class: 'full', maxlength: 20, value: loadNickname() });
  const msg = h('div', { class: 'error small' });
  const btn = h('button', { class: 'primary full', type: 'submit' }, '登入');
  const form = h('form', { class: 'card login-card', onSubmit: async (e) => {
    e.preventDefault();
    const email = toEmail(account.value);
    if (!email) { msg.textContent = '請輸入帳號'; return; }
    msg.textContent = ''; btn.disabled = true; btn.textContent = '登入中…';
    // 暱稱先存起來（空白＝之後顯示帳號名稱）
    saveNickname(nick.value.trim());
    try { await signInWithEmailAndPassword(auth, email, pw.value); }
    catch (err) { msg.textContent = ERR[err.code] || ('登入失敗：' + err.message); btn.disabled = false; btn.textContent = '登入'; }
  } },
    h('h1', {}, '行程規劃地圖'),
    h('p', { class: 'muted small' }, `請輸入團體帳號（例如 japan2028，會自動補上 @${ACCOUNT_DOMAIN}）`),
    h('label', { class: 'row col' }, '帳號', account),
    h('label', { class: 'row col' }, '密碼', pw),
    h('label', { class: 'row col' }, '暱稱', nick),
    h('div', { class: 'small muted' }, '暱稱用來顯示「建立者／最後修改」，存在這台電腦的瀏覽器；沒填就顯示帳號名稱。'),
    msg, btn);
  app.replaceChildren(h('div', { class: 'center-screen' }, form));
  setTimeout(() => account.focus(), 50);
  return () => {};
}

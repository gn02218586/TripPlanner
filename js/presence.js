// 線上使用者：每個瀏覽器分頁一份 presence/{工作階段 id}
// - 分頁在前景時每 2 分鐘回報一次；切到背景暫停，回到前景立刻回報；切換畫面時立刻回報
// - 登出時刪除自己的文件；關閉分頁時盡量刪除（不保證成功）
// - 管理員：即時訂閱整個 presence 集合，計算線上人數與名單
// 權限（firestore.rules）：每個帳號只能建立／更新／刪除 email 等於自己的文件；只有管理員能讀取與刪除全部
import {
  db, collection, doc, setDoc, updateDoc, deleteDoc, getDocs, onSnapshot, query, where, writeBatch, serverTimestamp,
} from './firebase.js';
import { state, emit, on } from './state.js';
import { currentEmail } from './accounts.js';
import { uid } from './utils.js';

export const PRESENCE_SESSION = uid() + uid();      // 這個分頁的工作階段 id
const REPORT_MS = 2 * 60 * 1000;
export const ONLINE_MS = 3 * 60 * 1000;            // 最後活動在 3 分鐘內＝線上
export const KEEP_MS = 7 * 24 * 60 * 60 * 1000;    // 保留 7 天

/** 瀏覽器簡稱，例如「Chrome / Windows」「Safari / iPhone」 */
export function browserName(ua = navigator.userAgent) {
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /(Chrome|CriOS)\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '瀏覽器';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} / ${os}` : b;
}
const BROWSER = browserName();

// ---------- 自己的回報 ----------
let running = false;
let created = false;     // 這個工作階段的文件是否已建立（之後用 updateDoc，讓規則檢查「只能改自己的」）
let timer = null;
let email = '';
let screen = { kind: 'home', text: '首頁' };
let offNick = null;
const ref = () => doc(db, 'presence', PRESENCE_SESSION);

function payload() {
  return {
    email, nickname: state.nickname || '', browser: BROWSER,
    screen: screen.kind, screenText: screen.text,
    projectName: screen.projectName || null, planName: screen.planName || null,
    lastActive: serverTimestamp(),
  };
}

async function report() {
  if (!running || document.visibilityState === 'hidden') return;
  const creating = !created;
  try {
    if (creating) {
      created = true;   // 先標記，避免同時回報時重複建立
      await setDoc(ref(), { ...payload(), startedAt: serverTimestamp() });
    } else {
      await updateDoc(ref(), payload());
    }
  } catch (e) {
    // 建立失敗，或文件不存在（例如被管理員清掉）：下次重新建立
    if (creating || e?.code === 'not-found') created = false;
    if (e?.code !== 'not-found') console.warn('線上狀態回報失敗', e?.code || e);
  }
}

function schedule() {
  clearInterval(timer); timer = null;
  if (running && document.visibilityState !== 'hidden') timer = setInterval(report, REPORT_MS);
}

function onVisibility() {
  if (document.visibilityState === 'hidden') { clearInterval(timer); timer = null; return; }
  report(); schedule();   // 回到前景：立刻回報一次，再重新計時
}

function onPageHide() {
  // 關閉分頁：盡量刪除（不等待、不保證成功）
  if (created) deleteDoc(ref()).catch(() => {});
}

/** 登入後開始回報 */
export function startPresence() {
  if (running) return;
  running = true; created = false;
  email = currentEmail();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  offNick = on('nickname', () => report());
  schedule();
  report();
}

/** 登出前：停止回報並刪除自己的文件 */
export async function stopPresence() {
  if (!running) return;
  running = false;
  clearInterval(timer); timer = null;
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('pagehide', onPageHide);
  offNick?.(); offNick = null;
  if (created) { created = false; await deleteDoc(ref()).catch(e => console.warn('刪除線上狀態失敗', e?.code || e)); }
}

/**
 * 目前畫面（切換畫面時立刻回報）
 * s：{ kind: 'home'|'plan'|'library'|'accounts', text, projectName?, planName? }
 */
export function setPresenceScreen(s) {
  if (screen.kind === s.kind && screen.text === s.text) return;
  screen = s;
  report();
}

// ---------- 管理員：即時名單 ----------
let unsub = null, tick = null;
/** [{ id, email, nickname, screenText, browser, at(毫秒), self }] */
export let presenceList = [];

export function startPresenceWatch() {
  if (unsub) return;
  unsub = onSnapshot(collection(db, 'presence'), (snap) => {
    presenceList = snap.docs.map(d => {
      // 剛寫入、伺服器時間還沒回來時用估計值
      const v = d.data({ serverTimestamps: 'estimate' });
      return { id: d.id, ...v, at: v.lastActive?.toMillis?.() ?? 0, self: d.id === PRESENCE_SESSION };
    });
    emit('presence');
  }, (e) => console.warn('線上名單訂閱失敗', e?.code || e));
  // 沒人寫入時，時間經過也可能有人變成離線：每 30 秒重新計算
  tick = setInterval(() => emit('presence'), 30 * 1000);
}

export function stopPresenceWatch() {
  unsub?.(); unsub = null;
  clearInterval(tick); tick = null;
  presenceList = [];
}

export const isOnline = (p, now = Date.now()) => now - p.at < ONLINE_MS;
export const onlineCount = () => presenceList.filter(p => isOnline(p)).length;

/** 各帳號的最後上線時間 Map<email, 毫秒> */
export function lastSeenByEmail() {
  const m = new Map();
  for (const p of presenceList) if (p.email && p.at > (m.get(p.email) || 0)) m.set(p.email, p.at);
  return m;
}

/** 管理員：刪除最後活動超過 7 天的文件（回傳刪除筆數） */
export async function cleanupOldPresence() {
  const snap = await getDocs(query(collection(db, 'presence'), where('lastActive', '<', new Date(Date.now() - KEEP_MS))));
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = writeBatch(db);
    snap.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
  return snap.size;
}

// Firestore 讀寫：專案、規劃、路線快取、歷史快照、即時同步與存檔衝突處理
import {
  db, collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, onSnapshot, runTransaction, writeBatch, deleteField,
} from './firebase.js';
import { state, emit, on, normalizePlan, fitPlanToProject, normDays, HOTEL_TAB_KIND } from './state.js';
import { debounce, clone, uid, toast, choose, fmtDateTime } from './utils.js';
import { isAdmin, currentEmail } from './accounts.js';
import { normalizeLibrary, mergeIntoLibrary, inferTabType, libTabForType } from './library.js';

const SESSION_ID = uid();          // 用來分辨「自己存的」與「別人存的」
const SAVE_DEBOUNCE = 2000;
const SNAPSHOT_GAP = 5 * 60 * 1000;
const HISTORY_KEEP = 20;

const projectsCol = () => collection(db, 'projects');
const plansCol = (pid) => collection(db, 'projects', pid, 'plans');
const planRef = (pid, planId) => doc(db, 'projects', pid, 'plans', planId);
const historyCol = (pid, planId) => collection(db, 'projects', pid, 'plans', planId, 'history');
const routeCol = (pid) => collection(db, 'projects', pid, 'routeCache');

// ---------- 專案 ----------
// 權限（firestore.rules）：一般帳號只能存取 ownerEmail 等於自己的專案與其子集合；管理員可存取全部。
// 規則要求查詢條件本身就保證權限，所以一般帳號必須用 where('ownerEmail', '==', 自己) 查詢，不能讀全部再過濾。
// 子集合的規則用 get() 讀上層專案（讀到的是寫入前的狀態），因此「建立專案」一定要先完成，
// 再另外寫入規劃等子集合；不要把建立專案與子集合放進同一個 batch／transaction。

/** 目前帳號可見的專案：管理員＝全部；一般帳號＝自己擁有的 */
export async function listProjects() {
  const q = isAdmin() ? projectsCol() : query(projectsCol(), where('ownerEmail', '==', currentEmail()));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
export async function getProject(id) {
  const s = await getDoc(doc(db, 'projects', id));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}
/**
 * 建立專案（等伺服器確認後才回傳，之後才能寫子集合）
 * 擁有帳號＝目前登入的帳號；管理員可以指定 ownerEmail（從首頁某個帳號組新建）
 */
export async function createProject(data, { ownerEmail = null } = {}) {
  const owner = ownerEmail && isAdmin() ? String(ownerEmail).toLowerCase() : currentEmail();
  const ref = await addDoc(projectsCol(), { ...clone(data), ownerEmail: owner, createdAt: Date.now() });
  return ref.id;
}
export async function updateProject(id, data) {
  await updateDoc(doc(db, 'projects', id), clone(data));
}

/**
 * 專案底下的子集合（Firestore 前端無法列出子集合；新增子集合時要加在這裡，刪除與複製專案才會處理到）
 * - PROJECT_SUBCOLLECTIONS：專案底下第一層，刪除與複製都會處理
 * - PLAN_SUBCOLLECTIONS：每個規劃底下的子集合，只在刪除時清掉（複製專案不複製歷史快照）
 */
export const PROJECT_SUBCOLLECTIONS = ['plans', 'routeCache', 'library'];
const PLAN_SUBCOLLECTIONS = ['history'];
const BATCH_MAX = 400;   // 每個 batch 最多 500 筆，保守一點
const SUB_LABEL = { plans: '規劃', routeCache: '路線快取', library: '專案備用庫' };

async function deleteRefs(refs) {
  for (let i = 0; i < refs.length; i += BATCH_MAX) {
    const batch = writeBatch(db);
    refs.slice(i, i + BATCH_MAX).forEach(r => batch.delete(r));
    await batch.commit();
  }
}

/**
 * 刪除專案：先刪所有子集合文件，最後才刪專案本身
 * （子集合的權限要靠上層專案的 ownerEmail 判斷，專案先刪掉的話子集合就再也刪不掉）
 * onProgress(text)：進度文字
 */
export async function deleteProject(pid, onProgress = () => {}) {
  for (const name of PROJECT_SUBCOLLECTIONS) {
    const snap = await getDocs(collection(db, 'projects', pid, name));
    if (name === 'plans') {
      // 每個規劃：先刪它底下的子集合（歷史快照），再刪規劃本身
      let n = 0;
      for (const p of snap.docs) {
        onProgress(`刪除規劃 ${++n} / ${snap.size}…`);
        for (const sub of PLAN_SUBCOLLECTIONS) {
          const hs = await getDocs(collection(db, 'projects', pid, 'plans', p.id, sub));
          await deleteRefs(hs.docs.map(d => d.ref));
        }
        await deleteDoc(p.ref);
      }
    } else {
      onProgress(`清除${SUB_LABEL[name] || name}…`);
      await deleteRefs(snap.docs.map(d => d.ref));
    }
  }
  onProgress('刪除專案…');
  await deleteDoc(doc(db, 'projects', pid));     // 最後才刪專案
}

/**
 * 管理員：把專案複製一份給指定帳號（原專案不變）
 * - 先建立專案文件（擁有帳號＝目標帳號、建立者＝目前暱稱、建立時間＝現在），完成後才寫子集合
 * - 子集合依 PROJECT_SUBCOLLECTIONS 複製，文件 id 不變；規劃內的建立者／最後修改保留；不複製歷史快照
 * - 每 400 筆一個 batch
 * 失敗時丟出的錯誤帶有 partialId（已建立的不完整複本 id，可能為 null）
 */
export async function copyProjectTo(srcId, { ownerEmail, name }, onProgress = () => {}) {
  if (!isAdmin()) throw new Error('只有管理員可以複製專案到其他帳號');
  let newId = null;
  try {
    onProgress('讀取原專案…');
    const src = await getProject(srcId);
    if (!src) throw new Error('找不到原專案');
    // 先讀完所有子集合，才知道總筆數
    const parts = [];
    for (const sub of PROJECT_SUBCOLLECTIONS) {
      const snap = await getDocs(collection(db, 'projects', srcId, sub));
      parts.push({ sub, docs: snap.docs });
    }
    const total = parts.reduce((n, p) => n + p.docs.length, 0);

    onProgress('建立新專案…');
    const { id: _omit, ...data } = src;
    const ref = await addDoc(projectsCol(), {
      ...clone(data), name, ownerEmail: String(ownerEmail).toLowerCase(),
      creatorNickname: state.nickname, createdAt: Date.now(),
    });
    newId = ref.id;

    let done = 0;
    for (const { sub, docs } of parts) {
      for (let i = 0; i < docs.length; i += BATCH_MAX) {
        const batch = writeBatch(db);
        for (const d of docs.slice(i, i + BATCH_MAX)) {
          const v = d.data();
          if (sub === 'plans') v.lastSessionId = null;   // 不沿用原本的編輯工作階段
          batch.set(doc(db, 'projects', newId, sub, d.id), v);
        }
        await batch.commit();
        done += Math.min(BATCH_MAX, docs.length - i);
        onProgress(`複製${SUB_LABEL[sub] || sub}… ${done} / ${total}`);
      }
    }
    return newId;
  } catch (e) {
    e.partialId = newId;
    throw e;
  }
}

/**
 * 管理員：把規劃複製到另一個專案（可以是任何帳號的專案，原規劃不變）
 * - 天數依目標專案調整（fitPlanToProject）；日期跟著目標專案；不複製歷史快照
 * - 路線快取：只複製這份規劃路段用到的，目標已有的略過
 * - 超出目標天數的行程點一律放進目標專案的備用庫（依類型選頁簽、天數＝不限）
 * - includeLibrary：同時把來源專案的備用庫合併到目標（同名頁簽合併、重複地點略過、超出目標天數的天拿掉）
 * 目標專案已存在，所以直接寫入規劃，再寫路線快取與備用庫
 * 回傳 { planId, routes, lib: { added, dup } | null }
 */
export async function copyPlanToProject(srcPid, planId, targetPid, { name, includeLibrary = true }, onProgress = () => {}) {
  if (!isAdmin()) throw new Error('只有管理員可以複製規劃到其他專案');
  onProgress('讀取規劃…');
  const [src, target] = await Promise.all([getPlan(srcPid, planId), getProject(targetPid)]);
  if (!src) throw new Error('找不到來源規劃');
  if (!target) throw new Error('找不到目標專案');
  const { data, movedStops } = fitPlanToProject(src, target);

  onProgress('建立規劃…');
  const newPlanId = await createPlan(targetPid, { name, ...data });

  // 路線快取：來源規劃各路段用到的 key
  const keys = new Set();
  (src.days || []).forEach(d => (d.stops || []).forEach(s => { if (s.leg?.gKey) keys.add(s.leg.gKey); }));
  let routes = 0;
  if (keys.size) {
    onProgress('複製路線快取…');
    const existing = new Set((await getDocs(routeCol(targetPid))).docs.map(d => d.id));
    const need = [...keys].filter(k => !existing.has(k));
    const found = [];
    for (let i = 0; i < need.length; i += 20) {
      const part = need.slice(i, i + 20);
      const snaps = await Promise.all(part.map(k => getDoc(doc(db, 'projects', srcPid, 'routeCache', k))));
      snaps.forEach((sn, j) => { if (sn.exists()) found.push([part[j], sn.data()]); });
    }
    for (let i = 0; i < found.length; i += BATCH_MAX) {
      const batch = writeBatch(db);
      found.slice(i, i + BATCH_MAX).forEach(([k, v]) => batch.set(doc(db, 'projects', targetPid, 'routeCache', k), v));
      await batch.commit();
    }
    routes = found.length;
  }

  let lib = null;
  const srcLib = includeLibrary ? await getLibrary(srcPid) : null;
  if (srcLib || movedStops.length) {
    onProgress('合併備用庫…');
    const fit = (days) => normDays(days).filter(d => d <= target.numDays);
    lib = await updateLibraryTx(targetPid, (l) => {
      const entries = [
        ...(srcLib ? srcLib.tabs.flatMap(t => t.items.map(it => ({ tabName: t.name, tabType: t.type, pt: { ...it, days: fit(it.days) } }))) : []),
        // 超出目標天數的行程點：依類型放進目標的頁簽，天數＝不限
        ...movedStops.map(st => { const tab = libTabForType(st.type, l); return { tabName: tab.name, tabType: tab.type, pt: { ...st, days: [] } }; }),
      ];
      return mergeIntoLibrary(l, entries, { tabSpecs: srcLib ? srcLib.tabs.map(t => ({ name: t.name, type: t.type })) : [] });
    });
  }
  return { planId: newPlanId, routes, lib };
}

// ---------- 舊資料轉移：本規劃備用庫 → 專案備用庫 ----------
/**
 * 把專案內各規劃還保留的舊「本規劃備用庫」合併到專案備用庫（只做一次）
 * - 同名頁簽合併，沒有的頁簽新增（類型：住宿類頁簽＝住宿、名稱含「餐廳」＝餐廳、其他＝景點）
 * - 重複地點略過；保留天數、備註、加入者
 * - 專案備用庫寫入成功後，才清除各規劃的 backup 欄位並記錄 backupMigrated（不改版本號，不影響正在編輯的人）
 * - 專案備用庫寫入失敗時丟出錯誤，舊資料不清除；清到一半失敗時下次會再合併（重複略過，不會重複）
 * 回傳 { plans: 有備用點的規劃數, added }；沒有要轉移的回傳 null
 */
export async function migratePlanBackups(pid) {
  const snap = await getDocs(plansCol(pid));
  const todo = snap.docs.filter(d => { const v = d.data(); return v.backup && !v.backupMigrated; });
  if (!todo.length) return null;
  const tabSpecs = [], entries = [];
  let plans = 0;
  for (const d of todo) {
    let n = 0;
    for (const t of d.data().backup?.tabs || []) {
      const tabType = t.kind === HOTEL_TAB_KIND ? 'hotel' : inferTabType(t.name || '');
      const name = String(t.name || '備用').trim() || '備用';
      tabSpecs.push({ name, type: tabType });
      for (const it of t.items || []) { entries.push({ tabName: name, tabType, pt: { ...it } }); n++; }
    }
    if (n) plans++;
  }
  let added = 0;
  if (entries.length || tabSpecs.length) {
    const r = await updateLibraryTx(pid, (l) => mergeIntoLibrary(l, entries, { tabSpecs }));
    added = r.added;
  }
  for (const d of todo) await updateDoc(d.ref, { backup: deleteField(), backupMigrated: true });
  return { plans, added };
}

// ---------- 規劃 ----------
export async function listPlans(pid) {
  const snap = await getDocs(plansCol(pid));
  return snap.docs.map(d => {
    const { name, creator, lastEditor, updatedAt } = d.data();
    return { id: d.id, name, creator, lastEditor, updatedAt };
  }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
export async function getPlan(pid, planId) {
  const s = await getDoc(planRef(pid, planId));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}
export async function createPlan(pid, { name, days }) {
  const now = Date.now();
  const ref = await addDoc(plansCol(pid), clone({
    name, creator: state.nickname, lastEditor: state.nickname, updatedAt: now, version: 1,
    lastSessionId: SESSION_ID, days, backupMigrated: true,
  }));
  return ref.id;
}
export async function deletePlan(pid, planId) {
  const hs = await getDocs(historyCol(pid, planId));
  const batch = writeBatch(db);
  hs.docs.forEach(d => batch.delete(d.ref));
  batch.delete(planRef(pid, planId));
  await batch.commit();
}

// ---------- 路線快取 ----------
export async function loadRouteCache(pid) {
  const snap = await getDocs(routeCol(pid));
  return snap.docs.map(d => ({ key: d.id, ...d.data() }));
}
export async function getRouteCacheDoc(pid, key) {
  const s = await getDoc(doc(db, 'projects', pid, 'routeCache', key));
  return s.exists() ? s.data() : null;
}
export async function setRouteCacheDoc(pid, key, data) {
  await setDoc(doc(db, 'projects', pid, 'routeCache', key), { ...data, createdAt: Date.now() });
}

// ---------- 歷史 ----------
export async function listHistory(pid, planId) {
  const snap = await getDocs(query(historyCol(pid, planId), orderBy('savedAt', 'desc'), limit(HISTORY_KEEP)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function addHistory() {
  if (!session) return;
  const { pid, planId } = session;
  session.lastSnapshotAt = Date.now();
  await addDoc(historyCol(pid, planId), {
    savedAt: Date.now(), editor: state.nickname,
    snapshot: clone({ days: state.plan.days }),
  });
  const snap = await getDocs(query(historyCol(pid, planId), orderBy('savedAt', 'desc')));
  const extra = snap.docs.slice(HISTORY_KEEP);
  if (extra.length) {
    const batch = writeBatch(db);
    extra.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
}

// ---------- 規劃編輯工作階段 ----------
let session = null;
// session: { pid, planId, baseVersion, editCounter, savedCounter, saving, lastSnapshotAt, unsub, offDirty, conflictOpen }

const debouncedSave = debounce(() => saveNow(), SAVE_DEBOUNCE);

function setStatus(s) { emit('saveStatus', s); }
export const hasUnsaved = () => !!session && (session.editCounter !== session.savedCounter || session.saving);

export async function startPlanSession(pid, planId) {
  await endPlanSession();
  const data = await getPlan(pid, planId);
  if (!data) throw new Error('找不到這個規劃');
  session = {
    pid, planId, baseVersion: data.version || 0, editCounter: 0, savedCounter: 0,
    saving: false, lastSnapshotAt: 0, unsub: null, conflictOpen: false,
  };
  state.planId = planId;
  state.plan = data;
  normalizePlan(state.plan, state.project);
  session.offDirty = on('dirty', () => { session.editCounter++; setStatus('dirty'); debouncedSave(); });
  addHistory().catch(e => console.warn('歷史快照失敗', e));     // 開啟規劃時先存一筆
  const my = session;
  session.unsub = onSnapshot(planRef(pid, planId), (snap) => { if (session === my) handleRemote(snap); });
  setStatus('saved');
}

export async function endPlanSession() {
  if (!session) return;
  const s = session;
  if (s.editCounter !== s.savedCounter) { debouncedSave.cancel(); await saveNow(); }
  s.unsub?.(); s.offDirty?.();
  if (session === s) session = null;
}

/** 立即存檔（transaction 檢查 version） */
export async function saveNow(force = false) {
  const s = session;
  if (!s || s.conflictOpen) return;
  if (s.saving) { debouncedSave(); return; }
  if (!force && s.editCounter === s.savedCounter) return;
  s.saving = true; setStatus('saving');
  const startCounter = s.editCounter;
  // 只存名稱與行程；備用庫是專案層級的另一份文件（舊資料的 backup 欄位由轉移程式清除）
  const payload = clone({ name: state.plan.name, days: state.plan.days });
  let conflict = null, result = null;
  try {
    result = await runTransaction(db, async (tx) => {
      const ref = planRef(s.pid, s.planId);
      const cur = await tx.get(ref);
      if (!cur.exists()) throw new Error('這個規劃已被刪除');
      const remote = cur.data();
      if (!force && (remote.version || 0) !== s.baseVersion) return { conflict: remote };
      const version = (remote.version || 0) + 1;
      const updatedAt = Date.now();
      tx.update(ref, { ...payload, lastEditor: state.nickname, updatedAt, version, lastSessionId: SESSION_ID });
      return { version, updatedAt };
    });
  } catch (e) {
    console.error(e);
    s.saving = false; setStatus('error');
    toast('存檔失敗：' + e.message, 'error', 6000);
    return;
  }
  s.saving = false;
  if (session !== s) return;
  if (result.conflict) { conflict = result.conflict; return handleConflict(conflict); }
  s.baseVersion = result.version;
  Object.assign(state.plan, { version: result.version, updatedAt: result.updatedAt, lastEditor: state.nickname });
  s.savedCounter = startCounter;
  if (Date.now() - s.lastSnapshotAt > SNAPSHOT_GAP) addHistory().catch(e => console.warn(e));
  if (s.editCounter !== s.savedCounter) debouncedSave(); else setStatus('saved');
}

async function handleConflict(remote) {
  const s = session;
  s.conflictOpen = true;
  setStatus('conflict');
  const v = await choose('存檔衝突',
    `雲端的規劃在你載入後已被「${remote.lastEditor || '其他人'}」修改（${fmtDateTime(remote.updatedAt)}）。\n要怎麼處理？`,
    [{ label: '載入對方的版本', value: 'load' }, { label: '確定覆蓋', value: 'overwrite', class: 'danger' }]);
  s.conflictOpen = false;
  if (session !== s) return;
  if (v === 'overwrite') return saveNow(true);
  if (v === 'load') {
    const fresh = await getPlan(s.pid, s.planId);
    if (fresh) applyRemote(fresh);
    toast('已載入對方的版本');
  } else {
    setStatus('dirty'); // 取消：維持未存狀態，下次修改再試
  }
}

function applyRemote(data) {
  const s = session;
  s.baseVersion = data.version || 0;
  s.savedCounter = s.editCounter;
  debouncedSave.cancel();
  state.plan = { ...data };
  delete state.plan.id;
  normalizePlan(state.plan, state.project);
  emit('plan');
  setStatus('saved');
}

function handleRemote(snap) {
  const s = session;
  if (!snap.exists()) { toast('這個規劃已被刪除', 'error'); return; }
  if (snap.metadata.hasPendingWrites) return;
  const data = snap.data();
  if ((data.version || 0) <= s.baseVersion) return;
  if (data.lastSessionId === SESSION_ID) { s.baseVersion = Math.max(s.baseVersion, data.version || 0); return; }
  const who = data.lastEditor || '其他人';
  if (s.editCounter === s.savedCounter && !s.saving) {
    applyRemote(data);
    toast(`「${who}」剛修改了這個規劃，已自動載入最新版本`);
  } else {
    emit('remoteChange', {
      who, apply: () => applyRemote(data),
    });
  }
}

/** 還原歷史快照（當作一次一般修改，會正常存檔） */
export function restoreSnapshot(snapshot, mutate) {
  // 舊快照裡的本規劃備用庫不再使用，只還原行程
  mutate(p => { p.days = clone(snapshot.days); });
}

export const currentSession = () => session;

// ---------- 專案備用庫（projects/{pid}/library/main） ----------
const libraryRef = (pid) => doc(db, 'projects', pid, 'library', 'main');
const libPayload = (lib) => clone({ tabs: lib.tabs });

/** 讀取（沒有文件時回傳空的三個頁簽） */
export async function getLibrary(pid) {
  const s = await getDoc(libraryRef(pid));
  return normalizeLibrary(s.exists() ? s.data() : null);
}

/**
 * 不經編輯工作階段直接修改（匯入行程放到專案備用庫用）
 * fn(lib) 在 transaction 內對最新資料修改（可能重試，fn 須只依 lib 計算）；回傳 fn 的回傳值
 */
export async function updateLibraryTx(pid, fn) {
  return runTransaction(db, async (tx) => {
    const ref = libraryRef(pid);
    const cur = await tx.get(ref);
    const remote = cur.exists() ? cur.data() : {};
    const lib = normalizeLibrary(remote);
    const result = fn(lib);
    tx.set(ref, {
      ...libPayload(lib), version: (remote.version || 0) + 1, updatedAt: Date.now(),
      lastEditor: state.nickname, lastSessionId: SESSION_ID,
    });
    return result;
  });
}

// 編輯工作階段（專案備用庫編輯畫面）：與規劃相同的 2 秒自動存檔、版本檢查、即時同步與衝突處理
let libSession = null;
const debouncedLibSave = debounce(() => saveLibraryNow(), SAVE_DEBOUNCE);
const setLibStatus = (s) => emit('libSaveStatus', s);
export const hasUnsavedLibrary = () => !!libSession && (libSession.editCounter !== libSession.savedCounter || libSession.saving);

export async function startLibrarySession(pid) {
  await endLibrarySession();
  const s = await getDoc(libraryRef(pid));
  const data = s.exists() ? s.data() : null;
  state.library = normalizeLibrary(data);
  const my = libSession = { pid, baseVersion: data?.version || 0, editCounter: 0, savedCounter: 0, saving: false, conflictOpen: false };
  my.offDirty = on('libDirty', () => { my.editCounter++; setLibStatus('dirty'); debouncedLibSave(); });
  my.unsub = onSnapshot(libraryRef(pid), (snap) => { if (libSession === my) handleLibRemote(snap); },
    (e) => console.warn('專案備用庫同步失敗', e));
  setLibStatus('saved');
}

export async function endLibrarySession() {
  if (!libSession) return;
  const s = libSession;
  if (s.editCounter !== s.savedCounter) { debouncedLibSave.cancel(); await saveLibraryNow(); }
  s.unsub?.(); s.offDirty?.();
  if (libSession === s) libSession = null;
}

export async function saveLibraryNow(force = false) {
  const s = libSession;
  if (!s || s.conflictOpen) return;
  if (s.saving) { debouncedLibSave(); return; }
  if (!force && s.editCounter === s.savedCounter) return;
  s.saving = true; setLibStatus('saving');
  const startCounter = s.editCounter;
  const payload = libPayload(state.library);
  let result;
  try {
    result = await runTransaction(db, async (tx) => {
      const ref = libraryRef(s.pid);
      const cur = await tx.get(ref);
      const remote = cur.exists() ? cur.data() : {};
      if (!force && (remote.version || 0) !== s.baseVersion) return { conflict: remote };
      const version = (remote.version || 0) + 1;
      tx.set(ref, { ...payload, version, updatedAt: Date.now(), lastEditor: state.nickname, lastSessionId: SESSION_ID });
      return { version };
    });
  } catch (e) {
    console.error(e);
    s.saving = false; setLibStatus('error');
    toast('專案備用庫存檔失敗：' + e.message, 'error', 6000);
    return;
  }
  s.saving = false;
  if (libSession !== s) return;
  if (result.conflict) return handleLibConflict(result.conflict);
  s.baseVersion = result.version;
  s.savedCounter = startCounter;
  if (s.editCounter !== s.savedCounter) debouncedLibSave(); else setLibStatus('saved');
}

async function handleLibConflict(remote) {
  const s = libSession;
  s.conflictOpen = true;
  setLibStatus('conflict');
  const v = await choose('存檔衝突',
    `專案備用庫在你載入後已被「${remote.lastEditor || '其他人'}」修改（${fmtDateTime(remote.updatedAt)}）。\n要怎麼處理？`,
    [{ label: '載入對方的版本', value: 'load' }, { label: '確定覆蓋', value: 'overwrite', class: 'danger' }]);
  s.conflictOpen = false;
  if (libSession !== s) return;
  if (v === 'overwrite') return saveLibraryNow(true);
  if (v === 'load') {
    const fresh = await getDoc(libraryRef(s.pid));
    applyLibRemote(fresh.exists() ? fresh.data() : {});
    toast('已載入對方的版本');
  } else setLibStatus('dirty');
}

function applyLibRemote(data) {
  const s = libSession;
  s.baseVersion = data.version || 0;
  s.savedCounter = s.editCounter;
  debouncedLibSave.cancel();
  state.library = normalizeLibrary(data);
  emit('library');
  setLibStatus('saved');
}

function handleLibRemote(snap) {
  const s = libSession;
  if (!snap.exists() || snap.metadata.hasPendingWrites) return;
  const data = snap.data();
  if ((data.version || 0) <= s.baseVersion) return;
  if (data.lastSessionId === SESSION_ID) { s.baseVersion = Math.max(s.baseVersion, data.version || 0); return; }
  const who = data.lastEditor || '其他人';
  if (s.editCounter === s.savedCounter && !s.saving) {
    applyLibRemote(data);
    toast(`「${who}」剛修改了專案備用庫，已自動載入最新版本`);
  } else {
    emit('libRemoteChange', { who, apply: () => applyLibRemote(data) });
  }
}

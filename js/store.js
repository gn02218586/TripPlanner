// Firestore 讀寫：專案、規劃、路線快取、歷史快照、即時同步與存檔衝突處理
import {
  db, collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, onSnapshot, runTransaction, writeBatch,
} from './firebase.js';
import { state, emit, on, normalizePlan } from './state.js';
import { debounce, clone, uid, toast, choose, fmtDateTime } from './utils.js';

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
export async function listProjects() {
  const snap = await getDocs(projectsCol());
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
export async function getProject(id) {
  const s = await getDoc(doc(db, 'projects', id));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}
export async function findProjectByName(name) {
  const snap = await getDocs(query(projectsCol(), where('name', '==', name)));
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}
export async function createProject(data) {
  const ref = await addDoc(projectsCol(), { ...clone(data), createdAt: Date.now() });
  return ref.id;
}
export async function updateProject(id, data) {
  await updateDoc(doc(db, 'projects', id), clone(data));
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
export async function createPlan(pid, { name, days, backup }) {
  const now = Date.now();
  const ref = await addDoc(plansCol(pid), clone({
    name, creator: state.nickname, lastEditor: state.nickname, updatedAt: now, version: 1,
    lastSessionId: SESSION_ID, days, backup,
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
    snapshot: clone({ days: state.plan.days, backup: state.plan.backup }),
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
  const payload = clone({ name: state.plan.name, days: state.plan.days, backup: state.plan.backup });
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
  mutate(p => { p.days = clone(snapshot.days); p.backup = clone(snapshot.backup); });
}

export const currentSession = () => session;

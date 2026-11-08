// 地圖小視窗、搜尋結果與備用庫清單共用的介面元件
import { h, selectEl, fmtDate, confirmDialog, openModal, toast } from './utils.js?v=2026-11-08-2';
import { state, TYPES, TYPE_LABEL, DEFAULT_STAY, addStopSmart, findStop, scheduledDays, normDays } from './state.js?v=2026-11-08-2';
import { findLibItem, removeLibItem, addLibItem, libTabForType } from './library.js?v=2026-11-08-2';
import { dayColor } from './markers.js?v=2026-11-08-2';

export const typeOptions = () => TYPES.map(t => ({ value: t, label: TYPE_LABEL[t] }));

/**
 * 鎖定（唯讀）：停用容器內的輸入框、選單與按鈕，容器加上 is-ro
 * 放在 .ro-keep 裡（或本身有 ro-keep）的控制項不停用（例如選天、重試路線）
 */
export function lockControls(el, ro) {
  if (!el) return el;
  el.classList.toggle('is-ro', !!ro);
  if (ro) el.querySelectorAll('input, select, textarea, button').forEach(x => { if (!x.closest('.ro-keep')) x.disabled = true; });
  return el;
}
export const dayOptions = () => state.plan.days.map((d, i) => ({ value: i, label: `Day ${i + 1}  ${fmtDate(d.date)}` }));
/** 備用庫頁簽選單 */
export const tabOptions = () => (state.library?.tabs || []).map(t => ({ value: t.id, label: t.name }));
/** 預設加入的天：選取點所在天 → 篩選中的天 → Day 1 */
export const defaultDayIdx = () => {
  if (state.selectedStop && state.selectedStartOf != null) return state.selectedStartOf;
  return (state.selectedStop && findStop(state.selectedStop)?.dayIdx) ?? state.selectedDay ?? 0;
};

/** 「加入」按鈕文字：該天有選取點時插在它後面（選取起點列時插在這天開頭） */
export function addButtonLabel(dayIdx) {
  if (state.selectedStop && state.selectedStartOf === dayIdx) return '加在起點後面（這天第一站）';
  const f = state.selectedStop && state.selectedStartOf == null && findStop(state.selectedStop);
  return f && f.dayIdx === dayIdx ? `加在「${f.stop.name}」後面` : '加到這天最後';
}

/** 天選單＋加入按鈕（按鈕文字隨所選的天變化） */
export function dayAddRow(onAdd) {
  const daySel = selectEl(dayOptions(), defaultDayIdx());
  const btn = h('button', { class: 'primary', onClick: () => onAdd(+daySel.value) }, addButtonLabel(defaultDayIdx()));
  daySel.addEventListener('change', () => { btn.textContent = addButtonLabel(+daySel.value); });
  // 行程被鎖定時不能加入
  return lockControls(h('div', { class: 'row' }, daySel, btn), state.planRO);
}

// ---------- 天數：顏色與右上天數篩選按鈕相同（markers.dayColor） ----------
const projDays = () => state.project?.numDays ?? 1;
/** 第 d 天（1 起算）的顏色 */
export const dayTint = (d, numDays = projDays()) => dayColor(d - 1, numDays);

/** 單一天的彩色標籤；stale＝超出專案天數（刪除線、不生效） */
export function dayTag(d, { stale = false } = {}) {
  return h('span', { class: 'day-tag' + (stale ? ' stale' : ''), style: { '--c': stale ? '#999' : dayTint(d) },
    title: stale ? `D${d} 超出專案天數，不生效` : null }, `D${d}`);
}

/** 天數多選：「不限」＋ D1…Dn（可多選；全部取消＝不限）；回傳 { el, get() } */
export function dayPicker(initial = [], numDays = projDays()) {
  const sel = new Set(normDays(initial).filter(d => d <= numDays));
  const el = h('div', { class: 'day-pick' });
  const draw = () => el.replaceChildren(
    h('button', { type: 'button', class: 'dp-chip none' + (sel.size ? '' : ' active'), onClick: () => { sel.clear(); draw(); } }, '不限'),
    ...Array.from({ length: numDays }, (_, i) => i + 1).map(d => h('button', {
      type: 'button', class: 'dp-chip' + (sel.has(d) ? ' active' : ''), style: { '--c': dayTint(d, numDays) },
      onClick: () => { if (sel.has(d)) sel.delete(d); else sel.add(d); draw(); },
    }, `D${d}`)));
  draw();
  return { el, get: () => [...sel].sort((a, b) => a - b) };
}

/** 天數標籤（唯讀）：每個天各一個彩色標籤；不限＝灰色 */
export function daysTag(days) {
  const ds = normDays(days), n = projDays();
  const ok = ds.filter(d => d <= n), stale = ds.filter(d => d > n);
  return h('span', { class: 'days-tags', title: '這個備用點適用的天' },
    ok.length ? ok.map(d => dayTag(d)) : h('span', { class: 'day-tag none' }, '不限'),
    stale.map(d => dayTag(d, { stale: true })));
}

/** 天數按鈕：顯示目前設定（彩色標籤），點開可勾選；onSave(days) */
export function daysButton(days, onSave) {
  return h('button', {
    type: 'button', class: 'days-btn', title: '設定這個備用點適用哪幾天',
    onClick: async (e) => {
      e.stopPropagation();
      const picker = dayPicker(days);
      const m = openModal({
        title: '適用的天', body: h('div', {}, h('div', { class: 'small muted' }, '可多選；選「不限」＝每天都可用。'), picker.el),
        actions: [{ label: '取消', value: null }, { label: '確定', value: 'ok', class: 'primary' }],
      });
      if ((await m.result) === 'ok') onSave(picker.get());
    },
  }, daysTag(days));
}

/** 「已排入」標籤：每個天各一個彩色標籤（依目前開啟的規劃） */
export function scheduledTags(item) {
  const days = scheduledDays(item);
  if (!days.length) return null;
  return h('span', { class: 'sched-tags', title: '已排入目前規劃的行程' }, h('span', { class: 'sched-label' }, '已排入'), days.map(d => dayTag(d)));
}

/**
 * 「加到 Day X／加到備用庫」面板
 * pt: { name, placeId, lat, lng, type? }
 */
export function buildAddPanel(pt, { onDone } = {}) {
  const nameIn = h('input', { type: 'text', value: pt.name || '自訂地點', class: 'full' });
  const typeSel = selectEl(typeOptions(), pt.type || 'spot');
  const tabSel = selectEl(tabOptions(), state.libTab);
  // 選類型時，備用庫頁簽跟著換成同類型的頁簽
  typeSel.addEventListener('change', () => { if (state.library) tabSel.value = libTabForType(typeSel.value).id; });
  // 加到備用庫時的天：右上選了某一天就預設那一天，否則不限
  const picker = dayPicker(state.selectedDay != null ? [state.selectedDay + 1] : []);
  const data = () => ({
    ...pt, name: nameIn.value.trim() || '自訂地點', type: typeSel.value,
    stayMin: DEFAULT_STAY[typeSel.value],
  });
  // 鎖定：行程與備用庫各自停用（兩邊都鎖定時整個停用）
  return lockControls(h('div', { class: 'popup add-panel' },
    h('label', { class: 'row' }, '名稱', nameIn),
    h('label', { class: 'row' }, '類型', typeSel),
    dayAddRow((d) => { addStopSmart(d, data()); onDone?.(); }),
    lockControls(h('div', { class: 'row' }, tabSel,
      h('button', { onClick: () => {
        if (!state.library) { toast('備用庫載入中，請稍候', 'warn'); return; }
        const r = addLibItem(tabSel.value, { ...data(), days: picker.get() });
        if (!r) return;
        toast(r.added ? '已加到備用庫' : '備用庫已有這個地點', r.added ? 'ok' : 'warn');
        onDone?.();
      } }, '加到備用庫')), state.libRO),
    lockControls(h('div', { class: 'row small' }, h('span', { class: 'muted' }, '備用點適用：'), picker.el), state.libRO),
  ), state.planRO && state.libRO);
}

/** 刪除備用點（需確認；已排入行程時提示不影響行程） */
export async function confirmRemoveLibItem(itemId) {
  const f = findLibItem(itemId); if (!f) return false;
  const days = scheduledDays(f.item);
  const msg = days.length
    ? `「${f.item.name}」已排入目前規劃的 ${days.map(d => 'D' + d).join('、')}，刪除備用點不會影響行程。\n確定刪除？`
    : `確定從備用庫刪除「${f.item.name}」？\n（這個專案的所有規劃共用備用庫）`;
  if (!(await confirmDialog(msg, '刪除', true))) return false;
  removeLibItem(itemId);
  return true;
}

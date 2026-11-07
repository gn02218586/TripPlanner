// 地圖小視窗與搜尋結果共用的介面元件
import { h, selectEl, fmtDate, confirmDialog } from './utils.js';
import {
  state, TYPES, TYPE_LABEL, DEFAULT_STAY, HOTEL_TAB_KIND,
  addStopSmart, addBackupItem, findBackup, findStop, scheduledDays, removeBackupItem,
} from './state.js';

export const typeOptions = () => TYPES.map(t => ({ value: t, label: TYPE_LABEL[t] }));
export const dayOptions = () => state.plan.days.map((d, i) => ({ value: i, label: `Day ${i + 1}  ${fmtDate(d.date)}` }));
export const tabOptions = () => state.plan.backup.tabs.map(t => ({ value: t.id, label: t.name }));
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
  return h('div', { class: 'row' }, daySel, btn);
}

/**
 * 「加到 Day X／加到備用庫」面板
 * pt: { name, placeId, lat, lng, type? }
 */
export function buildAddPanel(pt, { onDone } = {}) {
  const nameIn = h('input', { type: 'text', value: pt.name || '自訂地點', class: 'full' });
  const typeSel = selectEl(typeOptions(), pt.type || 'spot');
  const tabSel = selectEl(tabOptions(), state.activeTab);
  const data = () => ({
    ...pt, name: nameIn.value.trim() || '自訂地點', type: typeSel.value,
    stayMin: DEFAULT_STAY[typeSel.value],
  });
  return h('div', { class: 'popup add-panel' },
    h('label', { class: 'row' }, '名稱', nameIn),
    h('label', { class: 'row' }, '類型', typeSel),
    dayAddRow((d) => { addStopSmart(d, data()); onDone?.(); }),
    h('div', { class: 'row' }, tabSel,
      h('button', { onClick: () => {
        const tab = state.plan.backup.tabs.find(t => t.id === tabSel.value);
        const d = data();
        if (tab?.kind === HOTEL_TAB_KIND) { d.type = 'hotel'; d.stayMin = 0; }
        addBackupItem(tabSel.value, d); onDone?.();
      } }, '加到備用庫')),
  );
}

/** 刪除備用點（需確認；已排入行程時提示不影響行程） */
export async function confirmRemoveBackup(itemId) {
  const f = findBackup(itemId); if (!f) return false;
  const days = scheduledDays(f.item);
  const msg = days.length
    ? `「${f.item.name}」已排入 ${days.map(d => 'D' + d).join('、')}，刪除備用庫不會影響行程。\n確定刪除？`
    : `確定刪除備用點「${f.item.name}」？`;
  if (!(await confirmDialog(msg, '刪除', true))) return false;
  removeBackupItem(itemId);
  return true;
}

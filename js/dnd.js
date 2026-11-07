// 拖曳（SortableJS）共用設定與放開後的處理
// 清單種類（data-kind）：trip＝某天行程、backup＝目前頁簽內容、tabdrop＝頁簽按鈕（拖到別的頁簽）
import {
  state, emit, moveStop, backupToTrip, stopToBackup, moveBackupItem,
} from './state.js';

export function handleDragEnd(evt) {
  const fromK = evt.from.dataset.kind;
  const toK = evt.to.dataset.kind;
  const id = evt.item.dataset.id;
  const idx = evt.newIndex;
  // 等 Sortable 完成 DOM 收尾後，再改資料並重新繪製
  setTimeout(() => {
    if (fromK === 'trip' && toK === 'trip') moveStop(id, +evt.to.dataset.day, idx);
    else if (fromK === 'backup' && toK === 'trip') backupToTrip(id, +evt.to.dataset.day, idx);
    else if (fromK === 'trip' && toK === 'backup') stopToBackup(id, state.activeTab, idx);
    else if (fromK === 'trip' && toK === 'tabdrop') stopToBackup(id, evt.to.dataset.tab);
    else if (fromK === 'backup' && toK === 'backup') moveBackupItem(id, state.activeTab, idx);
    else if (fromK === 'backup' && toK === 'tabdrop') moveBackupItem(id, evt.to.dataset.tab);
    else emit('plan');
  }, 0);
}

export function makeSortable(el, opts = {}) {
  return new window.Sortable(el, {
    group: { name: 'tp', pull: true, put: true },
    animation: 150,
    delay: 180, delayOnTouchOnly: true,      // 觸控長按才拖，避免影響捲動
    emptyInsertThreshold: 24,
    filter: 'input,select,textarea,button,a',
    preventOnFilter: false,
    ghostClass: 'drag-ghost',
    onEnd: handleDragEnd,
    ...opts,
  });
}

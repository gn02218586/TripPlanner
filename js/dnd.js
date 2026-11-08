// 拖曳（SortableJS）共用設定與放開後的處理
// 清單種類（data-kind）：trip＝某天行程、backup＝備用庫目前頁簽、tabdrop＝備用庫頁簽按鈕（拖到別的頁簽）
import { state, emit, moveStop } from './state.js';
import { libToTrip, stopToLibrary, moveLibItem } from './library.js';

/**
 * 放開位置（依前後相鄰的點）：清單可能依天篩選，畫面上的順序不等於資料的 index
 * 回傳 { before: id }／{ after: id }／null（清單是空的＝放最後）
 */
export function domPos(item) {
  const sib = (el, dir) => { let e = el[dir]; while (e && !e.dataset?.id) e = e[dir]; return e; };
  const next = sib(item, 'nextElementSibling');
  if (next) return { before: next.dataset.id };
  const prev = sib(item, 'previousElementSibling');
  return prev ? { after: prev.dataset.id } : null;
}

export function handleDragEnd(evt) {
  const fromK = evt.from.dataset.kind;
  const toK = evt.to.dataset.kind;
  const id = evt.item.dataset.id;
  const idx = evt.newIndex;
  const same = evt.from === evt.to && evt.oldIndex === evt.newIndex;
  const pos = toK === 'backup' ? domPos(evt.item) : null;
  // 等 Sortable 完成 DOM 收尾後，再改資料並重新繪製
  setTimeout(() => {
    if (fromK === 'trip' && toK === 'trip') moveStop(id, +evt.to.dataset.day, idx);
    else if (fromK === 'backup' && toK === 'trip') libToTrip(id, +evt.to.dataset.day, idx);   // 備用庫保留原點
    else if (fromK === 'trip' && toK === 'backup') stopToLibrary(id, state.libTab, pos);
    else if (fromK === 'trip' && toK === 'tabdrop') stopToLibrary(id, evt.to.dataset.tab);
    else if (fromK === 'backup' && toK === 'backup' && !same) moveLibItem(id, state.libTab, pos);
    else if (fromK === 'backup' && toK === 'tabdrop') moveLibItem(id, evt.to.dataset.tab);
    else { emit('plan'); emit('library'); }   // 沒有變動：重繪還原 DOM
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

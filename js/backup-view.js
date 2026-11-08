// 規劃畫面右下：備用庫（每個專案一份，所有規劃共用；可直接編輯）
// 「本日｜全部」依天篩選、地圖顯示備用點、隱藏已排入；滑鼠停 0.5 秒顯示與選取點的路線比較
import { state, on, emit, scheduledDays, backupDayFilter, itemForDay } from './state.js?v=2026-11-09-1';
import { findLibItem } from './library.js?v=2026-11-09-1';
import { compareNodes } from './markers.js?v=2026-11-09-1';
import { h } from './utils.js?v=2026-11-09-1';
import { requestCompare, compareInfo } from './compare.js?v=2026-11-09-1';
import { createLibraryPanel } from './library-panel.js?v=2026-11-09-1';
import { dayTint } from './ui-common.js?v=2026-11-09-1';

const HIDE_KEY = 'tripplanner.hideScheduled';
const loadHide = () => { try { return localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; } };
const saveHide = (v) => { try { localStorage.setItem(HIDE_KEY, v ? '1' : '0'); } catch { /* 只在本次有效 */ } };

export function createBackupView(container, { mapView, onToggleCollapse }) {
  const offs = [];
  let collapsed = false;
  let hideScheduled = loadHide();

  /** 右上選了某一天時：「本日｜全部」切換 */
  function dayModeSwitch() {
    if (state.selectedDay == null) return null;
    const btn = (v, label, title, color) => h('button', {
      class: 'seg-btn' + (state.backupDayMode === v ? ' active' : ''), title, style: color ? { '--c': color } : null,
      onClick: () => { if (state.backupDayMode === v) return; state.backupDayMode = v; panel.render(); emit('backupView'); },
    }, label);
    return h('div', { class: 'seg seg-day' },
      btn('day', `本日（D${state.selectedDay + 1}）`, '只顯示指定這一天與「不限」的備用點', dayTint(state.selectedDay + 1)),
      btn('all', '全部', '顯示所有備用點'));
  }

  const panel = createLibraryPanel(container, {
    showScheduled: true,
    filter: (it) => {
      const d = backupDayFilter();
      if (d != null && !itemForDay(it, d)) return false;
      if (hideScheduled && scheduledDays(it).length) return false;
      return true;
    },
    tools: () => [
      dayModeSwitch(),
      h('label', { class: 'small', title: '在地圖上以小標記顯示目前頁簽的備用點' },
        h('input', { type: 'checkbox', checked: state.showBackupOnMap, onChange: (e) => { state.showBackupOnMap = e.target.checked; emit('backupView'); } }), '地圖顯示備用點'),
      h('label', { class: 'small', title: '不顯示已排入目前規劃行程的點（選擇存在這台瀏覽器）' },
        h('input', { type: 'checkbox', checked: hideScheduled, onChange: (e) => { hideScheduled = e.target.checked; saveHide(hideScheduled); panel.render(); emit('backupView'); } }), '隱藏已排入'),
      h('a', { class: 'small-btn', href: `#/lib/${state.project.id}`, title: '開啟專案備用庫編輯畫面（地圖顯示全部備用點、匯入）' }, '專案備用庫畫面'),
    ],
    headExtra: () => [h('button', { class: 'collapse-btn', title: collapsed ? '展開備用庫' : '收起備用庫', onClick: () => {
      collapsed = !collapsed; onToggleCollapse(collapsed); panel.render();
    } }, collapsed ? '▲ 展開' : '▼ 收起')],
    onNameClick: (id) => mapView.focusLibItem(id),
    onRowEnter: (id, li) => hoverStart(id, li),
    onRowLeave: () => hoverEnd(),
    beforeRender: () => hoverEnd(),   // 清單重建時一併清掉暫時標記，避免殘留
    emptyHint: '這個頁簽還沒有地點；可從行程拖過來，或搜尋／點地圖加入',
  });

  // ---------- 滑鼠停留 0.5 秒：地圖暫時顯示＋與選取的行程點比較 ----------
  const HOVER_DELAY = 500;
  let hoverTimer = null;
  let hoverRow = null;   // { id, li, box }

  function hoverStart(itemId, li) {
    hoverEnd();
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      const f = findLibItem(itemId);
      if (!f) return;
      state.hoverBackup = { ...f.item };
      emit('backupHover');
      const box = h('div', { class: 'bcompare' });
      hoverRow = { id: itemId, li, box };
      li.append(box);
      requestCompare(f.item);
      renderCompare();
    }, HOVER_DELAY);   // 未滿 0.5 秒不查詢
  }

  function hoverEnd() {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    hoverRow?.box.remove();
    hoverRow = null;
    if (state.hoverBackup) { state.hoverBackup = null; emit('backupHover'); }
  }

  function renderCompare() {
    if (!hoverRow) return;
    const it = findLibItem(hoverRow.id)?.item;
    const c = compareInfo(it);
    if (!c) { hoverRow.box.remove(); return; }   // 沒有選取點：只在地圖顯示位置
    hoverRow.box.replaceChildren(...compareNodes(c));
    if (!hoverRow.box.isConnected) hoverRow.li.append(hoverRow.box);
  }

  // 行程變動（已排入標籤）、備用庫變動（自己或別人修改）、右上切換天（依天篩選）
  offs.push(on('plan', panel.render));
  offs.push(on('library', panel.render));
  offs.push(on('lock', panel.render));
  offs.push(on('select', panel.render));
  offs.push(on('routes', renderCompare));
  offs.push(on('stopSelect', () => {
    if (!hoverRow) return;
    const it = findLibItem(hoverRow.id)?.item;
    if (it) requestCompare(it);
    renderCompare();
  }));
  panel.render();

  return {
    destroy() { hoverEnd(); offs.forEach(f => f()); panel.destroy(); },
  };
}

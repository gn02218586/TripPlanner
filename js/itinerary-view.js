// 右上：行程流程（依天分組）、搜尋、路段資訊、拖曳排序
import { lib } from './maps-loader.js?v=2026-11-08-2';
import {
  state, on, emit, mutate, MODES, MODE_LABEL, updateStop, updateLeg, dayCharterHours, selectStop,
  prevPoint, findStop, removeStop,
} from './state.js?v=2026-11-08-2';
import { stopToLibrary } from './library.js?v=2026-11-08-2';
import { stopLabelMap, typeIcon, dayColor } from './markers.js?v=2026-11-08-2';
import { retryRoute, gmapsDirUrl } from './routes.js?v=2026-11-08-2';
import { h, selectEl, fmtHM, fmtDur, fmtDist, fmtDate, fmtShortDur, num, parseHM, toast, confirmDialog } from './utils.js?v=2026-11-08-2';
import { buildAddPanel, lockControls } from './ui-common.js?v=2026-11-08-2';
import { makeSortable } from './dnd.js?v=2026-11-08-2';

export async function createItineraryView(container, { getSchedule, mapView }) {
  const offs = [];
  let sortables = [];
  const editing = new Set(); // 正在手動輸入時間的路段（stop id）

  const searchBox = h('div', { class: 'search-box' });
  const searchResult = h('div', { class: 'search-result' });
  const chips = h('div', { class: 'day-chips' });
  const daysEl = h('div', { class: 'days scroll' });
  // 搜尋框（左）與天數篩選（右）同一行；寬度不夠時篩選按鈕換到第二行
  container.replaceChildren(h('div', { class: 'itin-toolbar' }, h('div', { class: 'itin-row' }, searchBox, chips), searchResult), daysEl);

  // ---------- 搜尋（Places API New：PlaceAutocompleteElement） ----------
  try {
    const { PlaceAutocompleteElement } = await lib('places');
    const b = state.project.bounds;
    const pac = new PlaceAutocompleteElement({
      locationRestriction: { north: b.n, south: b.s, east: b.e, west: b.w },
      requestedLanguage: 'zh-TW',
    });
    pac.setAttribute('placeholder', '搜尋地點…');
    pac.addEventListener('gmp-select', async ({ placePrediction }) => {
      try {
        // 名稱用候選文字；fetchFields 只取 id、location（Essentials）
        const name = placePrediction.mainText?.text || placePrediction.text?.text || '地點';
        const place = placePrediction.toPlace();
        await place.fetchFields({ fields: ['id', 'location'] });
        const pt = { name, placeId: place.id, lat: place.location.lat(), lng: place.location.lng() };
        mapView.map.panTo(pt);
        showResult(pt);
      } catch (e) { console.error(e); }
    });
    searchBox.append(pac);
  } catch (e) {
    searchBox.append(h('div', { class: 'error small' }, '搜尋元件載入失敗'));
  }

  function showResult(pt) {
    const close = () => searchResult.replaceChildren();
    searchResult.replaceChildren(h('div', { class: 'result-card' },
      h('button', { class: 'icon-btn close', title: '關閉', onClick: close }, '✕'),
      buildAddPanel(pt, { onDone: close })));
  }

  // ---------- 繪製 ----------
  function renderChips() {
    const n = state.plan.days.length;
    chips.replaceChildren(
      h('button', { class: 'chip' + (state.selectedDay == null ? ' active' : ''), onClick: () => selectDay(null) }, '全部'),
      ...state.plan.days.map((_, i) => h('button', {
        class: 'chip' + (state.selectedDay === i ? ' active' : ''), style: { '--c': dayColor(i, n) },
        onClick: () => selectDay(state.selectedDay === i ? null : i),
      }, `D${i + 1}`)));
  }

  function selectDay(i) {
    state.selectedDay = i;
    emit('select');
    daysEl.scrollTop = 0;
    if (i != null) mapView.fitDay(i);
  }

  let deferred = false;
  function render() {
    const a = document.activeElement;
    if (a && container.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) {
      if (!deferred) {
        deferred = true;
        a.addEventListener('blur', () => setTimeout(() => { deferred = false; render(); }, 0), { once: true });
      }
      return;
    }
    const scroll = daysEl.scrollTop;
    sortables.forEach(s => s.destroy());
    sortables = [];
    renderChips();
    const sched = getSchedule();
    const labels = stopLabelMap(state.plan);
    // 依天篩選：選了某天就只顯示那天
    const sel = state.selectedDay;
    daysEl.replaceChildren(...state.plan.days
      .map((day, di) => (sel == null || sel === di ? dayEl(day, di, sched[di], labels) : null))
      .filter(Boolean));
    // 鎖定：停用時間、停留、交通方式、包車、↩、× 等（選天、重試路線仍可用）
    lockControls(daysEl, state.planRO);
    // 行程與備用庫都被鎖定時，搜尋只會用來加入，隱藏
    searchBox.classList.toggle('hidden', !!(state.planRO && state.libRO));
    daysEl.scrollTop = scroll;
  }

  function dayEl(day, di, sd, labels) {
    const n = state.plan.days.length;
    const color = dayColor(di, n);
    const sel = state.selectedDay;

    const charterCb = h('input', { type: 'checkbox', checked: day.charter, onChange: () => mutate(p => { p.days[di].charter = charterCb.checked; }) });

    const ul = h('ul', { class: 'stop-list', dataset: { kind: 'trip', day: di } },
      day.stops.map((s, i) => stopEl(s, di, i, sd.stops[i], labels.get(s.id) || '', color)));
    sortables.push(makeSortable(ul, { handle: '.stop-card' }));

    // 起點列（第一天除外）：前一天最後一點；當天出發時間的輸入框放在這裡
    const origin = sd.isTripStart ? null : prevPoint(state.plan, di, 0);
    const startRow = origin ? startRowEl(origin, di, labels.get(origin.id) || '', dayColor(findStop(origin.id)?.dayIdx ?? di, n)) : null;

    const limit = dayCharterHours(di);
    return h('section', {
      class: 'day' + (sel === di ? ' selected' : ''),
      style: { '--c': color }, dataset: { daySection: di },
    },
      h('div', { class: 'day-head' },
        h('button', { class: 'day-title ro-keep', onClick: () => selectDay(sel === di ? null : di), title: sel === di ? '點選以顯示全部天' : '點選以只顯示這天' },
          h('span', { class: 'day-dot' }), `Day ${di + 1}`, h('span', { class: 'muted' }, fmtDate(day.date))),
        h('div', { class: 'day-controls' },
          h('label', {}, charterCb, '包車'))),
      startRow,
      ul,
      day.stops.length === 0 ? h('div', { class: 'empty-hint' }, '可從備用庫拖曳，或搜尋／點地圖加入') : null,
      h('div', { class: 'day-foot' },
        h('span', {}, `總里程 ${fmtDist(sd.totalDist)}`),
        h('span', {}, `交通 ${fmtDur(sd.travelMin)}`),
        h('span', {}, `結束 ${sd.end != null ? fmtHM(sd.end) : '—'}`),
        day.charter ? h('span', {}, `包車 ${fmtDur(sd.charterMin)} / ${limit ?? '—'} 小時`) : h('span', { class: 'muted' }, '不包車')),
      sd.warnings.length ? h('div', { class: 'day-warn' },
        sd.warnings.map(w => h('div', { class: w.level === 'error' ? 'error' : 'warn' }, '⚠ ' + w.text))) : null,
    );
  }

  function stopEl(s, di, i, st, label, color) {
    const stayIn = h('input', { type: 'number', min: 0, max: 999, step: 5, class: 'num stay-in', value: s.stayMin ?? 0,
      onChange: () => updateStop(s.id, { stayMin: Math.max(0, +stayIn.value || 0) }) });
    let times;
    if (st.isStart) {
      // 行程起點（例如 ✈去）：抵達時間（＝當天時間）可在這裡改 → 停留 → 出發
      times = h('span', { class: 'times', title: '抵達起點的時間；出發時間＝抵達＋停留' },
        '抵達 ', dayTimeInput(di), ' → 停留 ', stayIn, ` 分 → 出發 ${fmtHM(st.dep)}`);
    } else if (st.arr == null) times = h('span', { class: 'times' }, `出發 ${fmtHM(st.dep)}`);
    else if (s.type === 'hotel') times = h('span', { class: 'times' }, `抵達 ${fmtHM(st.arr)}（住宿）`);
    else times = h('span', { class: 'times' }, `抵達 ${fmtHM(st.arr)} → 停留 `, stayIn, ` 分 → 出發 ${fmtHM(st.dep)}`);

    // 交通（從前一點到此點）與抵達合併成一行；起點沒有前一段，只顯示時間
    const leg = st.leg ? legParts(s, st) : null;
    const selected = state.selectedStop === s.id && state.selectedStartOf == null;

    return h('li', { class: 'stop' + (selected ? ' selected-stop' : ''), dataset: { id: s.id } },
      h('div', {
        class: 'stop-card', title: '點選以選取（再點一次或按 Esc 取消）；拖曳可排序或移到別天',
        onClick: (e) => {
          if (e.target.closest('input,select,textarea,button,a')) return;
          selectStop(s.id);   // 地圖會自動縮放到抵達這個點的路段
        },
      },
        typeIcon(s.type, color),
        s.type !== 'airport' ? h('div', { class: 'stop-btns' },
          h('button', { class: 'icon-btn stop-btn', title: '移回備用庫', onClick: () => moveToBackup(s) }, '↩'),
          h('button', { class: 'icon-btn stop-btn danger-x', title: '從行程刪除', onClick: () => deleteStop(s) }, '×')) : null,
        h('div', { class: 'stop-main' },
          h('div', { class: 'stop-name' },
            label ? h('span', { class: 'stop-label', style: { background: color } }, label) : null,
            h('span', {}, s.name)),
          // 交通（不換行的一組）＋抵達時間（不換行的一組）；寬度不夠時從「抵達」開始換行
          h('div', { class: 'combo-line small' }, leg ? h('span', { class: 'leg-group' }, ...leg.line) : null, times),
          leg?.notes,
          s.note ? h('div', { class: 'stop-note small muted' }, s.note) : null)));
  }

  /**
   * ↩ 移回備用庫（會從行程移除；若正被選取會自動清除選取，路段隨後重算）
   * 備用庫已有同一地點：不重複新增；沒有：依類型放到對應頁簽，天數為原本那一天
   */
  function moveToBackup(s) {
    const r = stopToLibrary(s.id);
    if (r?.blocked) return;
    if (!r) { toast('已從行程移除（備用庫載入中，沒有加入）', 'warn'); return; }
    toast(r.existed ? `已從行程移除（備用庫已有「${s.name}」）` : `已移回備用庫「${r.tabName}」`, 'ok');
  }

  /** × 從行程刪除（需確認） */
  async function deleteStop(s) {
    if (state.planRO) { removeStop(s.id); return; }   // 鎖定：由 mutate 擋下並提示
    if (!(await confirmDialog(`確定從行程刪除「${s.name}」？`, '刪除', true))) return;
    removeStop(s.id);
  }

  /** 當天時間輸入框（第一天＝抵達起點，其他天＝從起點出發） */
  function dayTimeInput(di) {
    const inp = h('input', { type: 'time', class: 'day-time', value: state.plan.days[di].departTime, onChange: () => {
      if (parseHM(inp.value) != null) mutate(p => { p.days[di].departTime = inp.value; });
    } });
    return inp;
  }

  /** 起點列：由前一天最後一點推導，不能拖曳、刪除或改名；可選取 */
  function startRowEl(origin, di, label, color) {
    const selected = state.selectedStop === origin.id && state.selectedStartOf === di;
    const notHotel = origin.type !== 'hotel';
    return h('div', {
      class: 'start-row' + (selected ? ' selected-stop' : '') + (notHotel ? ' start-warn' : ''),
      title: '起點為前一天的最後一點，請在前一天修改',
      onClick: (e) => {
        if (e.target.closest('input,select,textarea,button,a')) return;
        selectStop(origin.id, true, di);
      },
    },
      h('div', { class: 'start-card' },
        typeIcon(origin.type, color),
        h('div', { class: 'stop-main' },
          h('div', { class: 'stop-name' },
            h('span', { class: 'start-tag' }, '起點'),
            label ? h('span', { class: 'stop-label', style: { background: color } }, label) : null,
            h('span', {}, origin.name)),
          h('div', { class: 'combo-line small' },
            h('span', { class: 'times', title: '從起點出發的時間' }, '出發 ', dayTimeInput(di))),
          notHotel ? h('div', { class: 'leg-note warn' }, '⚠ 前一天尚未安排住宿') : null)));
  }

  const MODE_ICON = { drive: '🚗', transit: '🚌', walk: '🚶', other: '✋' };

  /** 路段資訊：line＝與抵達同一行的部分；notes＝放在該行下方的提示 */
  function legParts(s, st) {
    const leg = s.leg;
    const d = st.leg;
    const from = st.from;
    // 收合時只顯示圖示（🚗▾），展開的選項顯示圖示＋文字：透明的原生 select 疊在圖示上
    const modeSel = selectEl(MODES.map(m => ({ value: m, label: `${MODE_ICON[m]} ${MODE_LABEL[m]}` })), leg.mode,
      { class: 'mode-sel', title: MODE_LABEL[leg.mode], onChange: () => updateLeg(s.id, { mode: modeSel.value }) });
    const modePick = h('span', { class: 'mode-pick' }, h('span', { class: 'mode-face' }, `${MODE_ICON[leg.mode]}▾`), modeSel);

    const setManual = (v) => {
      const m = num(v);
      editing.delete(s.id);
      if (m == null || m < 0) { emit('plan'); return; }
      updateLeg(s.id, { manualMin: m, manualFrom: { lat: from.lat, lng: from.lng }, manualTo: { lat: s.lat, lng: s.lng } });
    };
    const manualInput = () => {
      const inp = h('input', { type: 'number', min: 0, step: 1, class: 'num', value: leg.manualMin ?? (d.adjMin != null ? Math.round(d.adjMin) : ''), placeholder: '分' });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
      inp.addEventListener('change', () => setManual(inp.value));
      if (leg.mode !== 'other') setTimeout(() => inp.focus(), 0);
      return h('span', { class: 'manual-edit' }, inp, '分');
    };

    const line = [modePick];
    const notes = [];
    const inf = d.info;
    const isManual = leg.manualMin != null;
    if (leg.mode === 'other') {
      line.push(manualInput());
    } else {
      if (inf.status === 'pending') line.push(h('span', { class: 'muted' }, '計算中…'));
      else if (inf.status === 'error') line.push(h('span', { class: 'error' }, '查詢失敗'),
        h('button', { class: 'link-btn ro-keep', onClick: () => retryRoute(inf.key) }, '重試'));
      else if (inf.status === 'noRoute') notes.push(h('div', { class: 'leg-note warn' }, '⚠ Google 無資料，請手動輸入'));
      else if (inf.status === 'ok') {
        line.push(h('span', {}, fmtDist(inf.distanceMeters)));
        // 只顯示結果；滑鼠移上顯示計算過程
        const tip = leg.mode === 'drive' ? `Google ${fmtShortDur(d.gMin)} × 冬季係數 ${d.winter}` : `Google ${fmtShortDur(d.gMin)}`;
        line.push(h('span', { class: 'leg-time' + (isManual ? ' muted' : ''), title: tip }, fmtShortDur(d.adjMin)));
      }
      if (isManual && !editing.has(s.id)) line.push(h('span', { class: 'badge' }, `手動 ${fmtShortDur(leg.manualMin)}`));
      if (editing.has(s.id)) line.push(manualInput());
      line.push(h('button', { class: 'icon-btn', title: '手動輸入時間（不乘冬季係數）', onClick: () => { editing.add(s.id); render(); } }, '✏️'));
      if (isManual) line.push(h('button', { class: 'icon-btn', title: '恢復 Google 時間', onClick: () => updateLeg(s.id, { manualMin: null, manualFrom: null, manualTo: null }) }, '↺'));
    }
    line.push(h('a', { class: 'gm-icon', href: gmapsDirUrl(from, s, leg.mode), target: '_blank', rel: 'noopener', title: '在 Google Maps 開啟' }, '🗺'));
    // 匯入時標示「手動」的路段：還沒輸入手動時間前提醒
    if (leg.needManual && leg.manualMin == null) notes.push(h('div', { class: 'leg-note warn' }, '⚠ 請按 ✏️ 手動輸入時間'));
    if (d.moved) notes.push(h('div', { class: 'leg-moved' }, '⚠ 地點已變更，請確認時間 ',
      h('button', { class: 'link-btn', onClick: () => updateLeg(s.id, { manualFrom: { lat: from.lat, lng: from.lng }, manualTo: { lat: s.lat, lng: s.lng } }) }, '時間沒問題')));
    return { line, notes };
  }

  offs.push(on('plan', render));
  offs.push(on('lock', render));
  offs.push(on('routes', render));
  offs.push(on('select', render));
  offs.push(on('stopSelect', render));
  render();

  return { destroy() { offs.forEach(f => f()); sortables.forEach(s => s.destroy()); }, render };
}

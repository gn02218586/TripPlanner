// 右上：行程流程（依天分組）、搜尋、路段資訊、拖曳排序
import { lib } from './maps-loader.js';
import {
  state, on, emit, mutate, MODES, MODE_LABEL, updateStop, updateLeg, dayCharterHours,
} from './state.js';
import { stopLabelMap, typeIcon, dayColor } from './markers.js';
import { retryRoute, gmapsDirUrl } from './routes.js';
import { h, selectEl, fmtHM, fmtDur, fmtDist, fmtDate, num, parseHM } from './utils.js';
import { buildAddPanel } from './ui-common.js';
import { makeSortable } from './dnd.js';

export async function createItineraryView(container, { getSchedule, mapView }) {
  const offs = [];
  let sortables = [];
  const editing = new Set(); // 正在手動輸入時間的路段（stop id）

  const searchBox = h('div', { class: 'search-box' });
  const searchResult = h('div', { class: 'search-result' });
  const chips = h('div', { class: 'day-chips' });
  const daysEl = h('div', { class: 'days scroll' });
  container.replaceChildren(h('div', { class: 'itin-toolbar' }, searchBox, searchResult, chips), daysEl);

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
    if (i != null) {
      mapView.fitDay(i);
      daysEl.querySelector(`[data-day-section="${i}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
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
    daysEl.replaceChildren(...state.plan.days.map((day, di) => dayEl(day, di, sched[di], labels)));
    daysEl.scrollTop = scroll;
  }

  function dayEl(day, di, sd, labels) {
    const n = state.plan.days.length;
    const color = dayColor(di, n);
    const sel = state.selectedDay;
    const proj = state.project;

    const departIn = h('input', { type: 'time', value: day.departTime, onChange: () => {
      if (parseHM(departIn.value) != null) mutate(p => { p.days[di].departTime = departIn.value; });
    } });
    const charterCb = h('input', { type: 'checkbox', checked: day.charter, onChange: () => mutate(p => { p.days[di].charter = charterCb.checked; }) });
    const hoursIn = h('input', { type: 'number', min: 0, step: 0.5, class: 'num', value: day.charterHours ?? '', placeholder: String(proj.defaultCharterHours ?? ''),
      title: '留空＝沿用專案設定', onChange: () => mutate(p => { p.days[di].charterHours = num(hoursIn.value); }) });
    const winterIn = h('input', { type: 'text', inputmode: 'decimal', class: 'num', value: day.winterFactor ?? '', placeholder: String(proj.winterFactor ?? 1),
      title: '留空＝沿用專案設定', onChange: () => mutate(p => { p.days[di].winterFactor = num(winterIn.value); }) });

    const ul = h('ul', { class: 'stop-list', dataset: { kind: 'trip', day: di } },
      day.stops.map((s, i) => stopEl(s, di, i, sd.stops[i], labels.get(s.id) || '', color)));
    sortables.push(makeSortable(ul, { handle: '.stop-card' }));

    const limit = dayCharterHours(day);
    return h('section', {
      class: 'day' + (sel === di ? ' selected' : '') + (sel != null && sel !== di ? ' dimmed' : ''),
      style: { '--c': color }, dataset: { daySection: di },
    },
      h('div', { class: 'day-head' },
        h('button', { class: 'day-title', onClick: () => selectDay(sel === di ? null : di), title: '點選以突出顯示這天' },
          h('span', { class: 'day-dot' }), `Day ${di + 1}`, h('span', { class: 'muted' }, fmtDate(day.date))),
        h('div', { class: 'day-controls' },
          h('label', {}, '出發', departIn),
          h('label', {}, charterCb, '包車'),
          day.charter ? h('label', {}, '上限', hoursIn, '時') : null,
          h('label', { title: '開車時間 × 冬季係數' }, '冬季×', winterIn))),
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
    const stayIn = h('input', { type: 'number', min: 0, step: 5, class: 'num', value: s.stayMin ?? 0,
      onChange: () => updateStop(s.id, { stayMin: Math.max(0, +stayIn.value || 0) }) });
    let times;
    if (st.arr == null) times = h('span', {}, `出發 ${fmtHM(st.dep)}`);
    else if (s.type === 'hotel') times = h('span', {}, `抵達 ${fmtHM(st.arr)}（住宿）`);
    else times = h('span', { class: 'times' }, `抵達 ${fmtHM(st.arr)} → 停留 `, stayIn, ` 分 → 出發 ${fmtHM(st.dep)}`);

    return h('li', { class: 'stop', dataset: { id: s.id } },
      st.leg ? legEl(s, st) : null,
      h('div', { class: 'stop-card', title: '拖曳可排序或移到別天' },
        typeIcon(s.type, color),
        h('div', { class: 'stop-main' },
          h('div', { class: 'stop-name' },
            label ? h('span', { class: 'stop-label', style: { background: color } }, label) : null,
            h('a', { href: '#', onClick: (e) => { e.preventDefault(); mapView.focusStop(s.id); } }, s.name)),
          h('div', { class: 'stop-times small' }, times),
          s.note ? h('div', { class: 'stop-note small muted' }, s.note) : null)));
  }

  function legEl(s, st) {
    const leg = s.leg;
    const d = st.leg;
    const from = st.from;
    const modeSel = selectEl(MODES.map(m => ({ value: m, label: MODE_LABEL[m] })), leg.mode,
      { class: 'mode-sel', onChange: () => updateLeg(s.id, { mode: modeSel.value }) });

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

    const parts = [];
    const inf = d.info;
    if (leg.mode === 'other') {
      parts.push(h('span', {}, '手動輸入：'), manualInput());
    } else {
      if (inf.status === 'pending') parts.push(h('span', { class: 'muted' }, '計算中…'));
      else if (inf.status === 'error') parts.push(h('span', { class: 'error' }, '查詢失敗 '),
        h('button', { class: 'link-btn', onClick: () => retryRoute(inf.key) }, '重試'));
      else if (inf.status === 'noRoute') parts.push(h('span', { class: 'warn' }, 'Google 無資料，請手動輸入'));
      else if (inf.status === 'ok') {
        parts.push(h('span', {}, fmtDist(inf.distanceMeters)));
        if (leg.mode === 'drive') parts.push(h('span', { class: leg.manualMin != null ? 'muted' : '' },
          `Google ${fmtDur(d.gMin)} × ${d.winter} = ${fmtDur(d.adjMin)}`));
        else parts.push(h('span', { class: leg.manualMin != null ? 'muted' : '' }, `Google ${fmtDur(d.gMin)}`));
      }
      if (leg.manualMin != null && !editing.has(s.id)) parts.push(h('span', { class: 'badge' }, `手動 ${fmtDur(leg.manualMin)}`));
      if (editing.has(s.id)) parts.push(manualInput());
      parts.push(h('button', { class: 'icon-btn', title: '手動輸入時間（不乘冬季係數）', onClick: () => { editing.add(s.id); render(); } }, '✏️'));
      if (leg.manualMin != null) parts.push(h('button', { class: 'icon-btn', title: '恢復 Google 時間', onClick: () => updateLeg(s.id, { manualMin: null, manualFrom: null, manualTo: null }) }, '↺'));
    }
    parts.push(h('a', { class: 'gm-link', href: gmapsDirUrl(from, s, leg.mode), target: '_blank', rel: 'noopener', title: '在 Google Maps 開啟此段' }, '在 Google Maps 開啟'));

    return h('div', { class: `leg leg-${leg.mode}` },
      h('div', { class: 'leg-line' }, modeSel, ...parts),
      d.moved ? h('div', { class: 'leg-moved' }, '⚠ 地點已變更，請確認時間 ',
        h('button', { class: 'link-btn', onClick: () => updateLeg(s.id, { manualFrom: { lat: from.lat, lng: from.lng }, manualTo: { lat: s.lat, lng: s.lng } }) }, '時間沒問題')) : null);
  }

  offs.push(on('plan', render));
  offs.push(on('routes', render));
  offs.push(on('select', render));
  render();

  return { destroy() { offs.forEach(f => f()); sortables.forEach(s => s.destroy()); }, render };
}

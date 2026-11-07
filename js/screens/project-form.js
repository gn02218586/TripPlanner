// 建立專案／專案設定：地圖範圍（搜尋區域 viewport 或鎖定目前畫面）、日期、天數與各項預設值
import { lib } from '../maps-loader.js';
import { state, MODES, MODE_LABEL, TYPES, TYPE_LABEL } from '../state.js';
import { createProject, updateProject } from '../store.js';
import { h, selectEl, toast, num } from '../utils.js';

export async function openProjectForm({ project = null, onSaved }) {
  const isNew = !project;
  const canEditBounds = isNew || project.creatorNickname === state.nickname;
  let bounds = project?.bounds ? { ...project.bounds } : null;
  let defaultStart = project?.defaultStart ? { ...project.defaultStart } : null;
  let defaultEnd = project?.defaultEnd ? { ...project.defaultEnd } : null;

  const nameIn = h('input', { type: 'text', class: 'full', value: project?.name || '', placeholder: '例如：2027 北海道冬季' });
  const dateIn = h('input', { type: 'date', value: project?.startDate || '' });
  const daysIn = h('input', { type: 'number', min: 1, max: 30, class: 'num', value: project?.numDays ?? 5 });
  const modeSel = selectEl(MODES.map(m => ({ value: m, label: MODE_LABEL[m] })), project?.defaultMode || 'drive');
  const winterIn = h('input', { type: 'text', inputmode: 'decimal', class: 'num', value: project?.winterFactor ?? 1, title: '可填小數，例如 1.3' });
  const charterIn = h('input', { type: 'number', min: 0, step: 0.5, class: 'num', value: project?.defaultCharterHours ?? 10 });
  const latestIn = h('input', { type: 'time', value: project?.latestEndTime || '20:00' });
  const boundsText = h('div', { class: 'small' });
  const mapDiv = h('div', { class: 'pf-map' });

  const close = () => overlay.remove();
  const overlay = h('div', { class: 'modal-overlay' });
  const startBox = h('div', { class: 'pt-box' });
  const endBox = h('div', { class: 'pt-box' });

  const form = h('div', { class: 'pf-form scroll' },
    h('label', { class: 'row col' }, '專案名稱', nameIn),
    h('fieldset', {},
      h('legend', {}, '地圖範圍'),
      canEditBounds
        ? h('div', {},
          h('div', { class: 'small muted' }, '(1) 搜尋區域名稱，使用其範圍；或 (2) 把左邊地圖移到想要的位置後按「鎖定目前畫面範圍」。'),
          h('div', { class: 'region-search' }),
          h('button', { onClick: lockView }, '鎖定目前畫面範圍'))
        : h('div', { class: 'small muted' }, `只有專案建立者（${project.creatorNickname}）可以修改地圖範圍。`),
      boundsText),
    h('div', { class: 'grid2' },
      h('label', {}, '開始日期', dateIn),
      h('label', {}, '天數', daysIn),
      h('label', {}, '預設交通方式', modeSel),
      h('label', {}, '冬季係數', winterIn),
      h('label', {}, '每天包車時數', charterIn),
      h('label', {}, '最晚結束時間', latestIn)),
    h('fieldset', {}, h('legend', {}, '預設起點（Day 1 第一點）'), startBox),
    h('fieldset', {}, h('legend', {}, '預設終點（最後一天最後一點）'), endBox),
    !isNew ? h('div', { class: 'small muted' }, '預設起訖點只影響之後新建的空白規劃。') : null,
    h('div', { class: 'row end' },
      h('button', { onClick: close }, '取消'),
      h('button', { class: 'primary', onClick: save }, isNew ? '建立專案' : '儲存設定')));

  overlay.append(h('div', { class: 'modal modal-full' },
    h('div', { class: 'modal-head' }, h('h3', {}, isNew ? '建立專案' : '專案設定'), h('button', { class: 'icon-btn', onClick: close }, '✕')),
    h('div', { class: 'pf-grid' }, mapDiv, form)));
  document.body.append(overlay);

  // ---------- 地圖 ----------
  const { Map, Rectangle } = await lib('maps');
  const { PlaceAutocompleteElement } = await lib('places');
  const map = new Map(mapDiv, {
    center: { lat: 43.5, lng: 143 }, zoom: 6,
    mapTypeControl: false, streetViewControl: false, fullscreenControl: false, gestureHandling: 'greedy', clickableIcons: false,
  });
  const rect = new Rectangle({ map, strokeColor: '#d33', strokeWeight: 2, fillOpacity: 0.05, clickable: false });
  const pointPickers = [];

  function setBounds(b, fit = true) {
    bounds = b;
    const lit = { north: b.n, south: b.s, east: b.e, west: b.w };
    rect.setBounds(lit);
    if (fit) map.fitBounds(lit, 10);
    boundsText.textContent = `目前範圍：北緯 ${b.s.toFixed(3)}–${b.n.toFixed(3)}、東經 ${b.w.toFixed(3)}–${b.e.toFixed(3)}`;
    pointPickers.forEach(p => { p.locationRestriction = lit; });
  }
  if (bounds) setBounds(bounds); else boundsText.textContent = '尚未設定範圍';

  function lockView() {
    const v = map.getBounds()?.toJSON();
    if (!v) return;
    setBounds({ n: v.north, s: v.south, e: v.east, w: v.west }, false);
    toast('已鎖定目前畫面範圍', 'ok');
  }

  if (canEditBounds) {
    const pac = new PlaceAutocompleteElement({ requestedLanguage: 'zh-TW' });
    pac.setAttribute('placeholder', '搜尋區域，例如：北海道');
    pac.addEventListener('gmp-select', async ({ placePrediction }) => {
      const place = placePrediction.toPlace();
      await place.fetchFields({ fields: ['id', 'location', 'viewport'] });   // 皆屬 Essentials
      const v = place.viewport?.toJSON();
      if (v) setBounds({ n: v.north, s: v.south, e: v.east, w: v.west });
      else toast('這個地點沒有範圍資訊，請改用「鎖定目前畫面範圍」', 'warn');
    });
    form.querySelector('.region-search').append(pac);
  }

  // ---------- 預設起訖點 ----------
  function pointPicker(box, get, set) {
    const pac = new PlaceAutocompleteElement({ requestedLanguage: 'zh-TW' });
    if (bounds) pac.locationRestriction = { north: bounds.n, south: bounds.s, east: bounds.e, west: bounds.w };
    pac.setAttribute('placeholder', '搜尋地點（先設定地圖範圍）');
    pointPickers.push(pac);
    const info = h('div', { class: 'row' });
    const draw = () => {
      const p = get();
      info.replaceChildren(...(p ? [
        h('span', {}, p.name),
        selectEl(TYPES.map(t => ({ value: t, label: TYPE_LABEL[t] })), p.type || 'airport', { onChange: (e) => { p.type = e.target.value; } }),
        h('button', { class: 'icon-btn', title: '清除', onClick: () => { set(null); draw(); } }, '✕'),
      ] : [h('span', { class: 'muted small' }, '未設定')]));
    };
    pac.addEventListener('gmp-select', async ({ placePrediction }) => {
      const name = placePrediction.mainText?.text || placePrediction.text?.text || '地點';
      const place = placePrediction.toPlace();
      await place.fetchFields({ fields: ['id', 'location'] });
      set({ name, placeId: place.id, lat: place.location.lat(), lng: place.location.lng(), type: 'airport' });
      draw();
    });
    box.append(info, pac);
    draw();
  }
  pointPicker(startBox, () => defaultStart, (v) => { defaultStart = v; });
  pointPicker(endBox, () => defaultEnd, (v) => { defaultEnd = v; });

  async function save() {
    const data = {
      name: nameIn.value.trim(),
      startDate: dateIn.value,
      numDays: Math.round(num(daysIn.value, 0)),
      defaultMode: modeSel.value,
      winterFactor: num(winterIn.value, 1),
      defaultCharterHours: num(charterIn.value, 0),
      latestEndTime: latestIn.value || '20:00',
      defaultStart, defaultEnd,
    };
    if (!data.name) return toast('請輸入專案名稱', 'warn');
    if (!bounds) return toast('請設定地圖範圍', 'warn');
    if (!data.startDate) return toast('請選擇開始日期', 'warn');
    if (!(data.numDays >= 1 && data.numDays <= 30)) return toast('天數需在 1–30 之間', 'warn');
    if (!(data.winterFactor > 0)) return toast('冬季係數需大於 0', 'warn');
    if (canEditBounds) data.bounds = bounds;
    try {
      if (isNew) {
        const id = await createProject({ ...data, creatorNickname: state.nickname });
        toast('專案已建立', 'ok'); close(); onSaved?.(id);
      } else {
        await updateProject(project.id, data);
        toast('專案設定已儲存', 'ok'); close(); onSaved?.(project.id, data);
      }
    } catch (e) { toast('儲存失敗：' + e.message, 'error'); }
  }
}

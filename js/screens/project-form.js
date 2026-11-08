// 建立專案／專案設定：地圖範圍（搜尋區域 viewport 或鎖定目前畫面）、日期、天數與各項預設值
import { lib } from '../maps-loader.js';
import { state, MODES, MODE_LABEL, TYPES, TYPE_LABEL, deriveCharterTable } from '../state.js';
import { createProject, updateProject, deleteProject, copyProjectTo } from '../store.js';
import { h, selectEl, toast, num, fmtDate, addDays, confirmDialog, promptDialog, openModal } from '../utils.js';
import { isAdmin } from '../accounts.js';
import { accountPicker, accountTitle } from '../admin.js';

/**
 * onDeleted：有傳入時顯示「刪除專案」（只在首頁提供；地圖畫面開著規劃時不能刪）
 * onCopied(newId, ownerEmail)：管理員「複製到其他帳號」完成後呼叫（首頁用來重新載入列表）
 * ownerEmail：管理員從首頁某個帳號組「＋ 新建專案」時，新專案的擁有帳號直接設為這一組
 */
export async function openProjectForm({ project = null, plan = null, onSaved, onDeleted = null, onCopied = null, ownerEmail = null }) {
  const isNew = !project;
  const admin = isAdmin();
  const canEditBounds = isNew || admin || project.creatorNickname === state.nickname;
  // 擁有帳號（只有管理員看得到、可轉移）：已登記帳號的下拉選單＋「其他…」＋「未歸屬」
  const oldOwner = String(project?.ownerEmail || '').toLowerCase();
  const ownerPick = !isNew && admin ? accountPicker({ value: oldOwner, allowNone: true }) : null;
  let bounds = project?.bounds ? { ...project.bounds } : null;
  let defaultStart = project?.defaultStart ? { ...project.defaultStart } : null;
  let defaultEnd = project?.defaultEnd ? { ...project.defaultEnd } : null;

  const nameIn = h('input', { type: 'text', class: 'full', value: project?.name || '', placeholder: '例如：2027 北海道冬季' });
  const dateIn = h('input', { type: 'date', value: project?.startDate || '' });
  const daysIn = h('input', { type: 'number', min: 1, max: 30, class: 'num', value: project?.numDays ?? 5 });
  const modeSel = selectEl(MODES.map(m => ({ value: m, label: MODE_LABEL[m] })), project?.defaultMode || 'drive');
  const winterIn = h('input', { type: 'text', inputmode: 'decimal', class: 'num', value: project?.winterFactor ?? 1.3, title: '可填小數，例如 1.3' });
  const latestIn = h('input', { type: 'time', value: project?.latestEndTime || '20:00' });
  const boundsText = h('div', { class: 'small' });
  const mapDiv = h('div', { class: 'pf-map' });

  // ---------- 每日包車時數表、冬季係數 ----------
  // 預設值沿用目前資料：專案已有的表 → 目前規劃舊的每日覆蓋值 → 10 小時
  let charterHours = project ? deriveCharterTable(project, plan) : [];
  let winterPerDay = !!project?.winterPerDay;
  let winterByDay = project?.winterFactorsByDay ? [...project.winterFactorsByDay] : [];
  const charterTable = h('div', { class: 'day-table' });
  const winterTable = h('div', { class: 'day-table' });
  const winterPerDayCb = h('input', { type: 'checkbox', checked: winterPerDay });

  function dayRows() {
    const n = Math.max(0, Math.min(30, Math.round(num(daysIn.value, 0))));
    return Array.from({ length: n }, (_, i) => ({ i, label: `Day ${i + 1}${dateIn.value ? '　' + fmtDate(addDays(dateIn.value, i)) : ''}` }));
  }
  function renderCharterTable() {
    const rows = dayRows();
    charterHours = rows.map(r => charterHours[r.i] ?? charterHours[r.i - 1] ?? 10);
    charterTable.replaceChildren(...rows.map(r => h('label', { class: 'day-row' }, h('span', {}, r.label),
      h('span', {}, h('input', { type: 'number', min: 0, step: 0.5, class: 'num', value: charterHours[r.i],
        onChange: (e) => { charterHours[r.i] = Math.max(0, num(e.target.value, 0)); } }), ' 小時'))));
  }
  function renderWinterTable() {
    winterTable.classList.toggle('hidden', !winterPerDay);
    if (!winterPerDay) return;
    const base = num(winterIn.value, 1);
    const rows = dayRows();
    winterByDay = rows.map(r => winterByDay[r.i] ?? base);
    winterTable.replaceChildren(...rows.map(r => h('label', { class: 'day-row' }, h('span', {}, r.label),
      h('span', {}, '× ', h('input', { type: 'text', inputmode: 'decimal', class: 'num', value: winterByDay[r.i],
        onChange: (e) => { winterByDay[r.i] = num(e.target.value, base); } })))));
  }
  winterPerDayCb.addEventListener('change', () => {
    winterPerDay = winterPerDayCb.checked;
    // 勾選：每天帶入統一數值；取消：恢復全部使用統一數值
    if (winterPerDay) winterByDay = [];
    renderWinterTable();
  });
  dateIn.addEventListener('change', () => { renderCharterTable(); renderWinterTable(); });
  daysIn.addEventListener('change', () => { renderCharterTable(); renderWinterTable(); });
  renderCharterTable();
  renderWinterTable();

  const close = () => overlay.remove();
  const overlay = h('div', { class: 'modal-overlay' });
  const startBox = h('div', { class: 'pt-box' });
  const endBox = h('div', { class: 'pt-box' });

  const form = h('div', { class: 'pf-form scroll' },
    isNew && ownerEmail ? h('div', { class: 'small owner-note' }, `擁有帳號：${accountTitle(ownerEmail)}（${ownerEmail}）`) : null,
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
      h('label', {}, '最晚結束時間', latestIn)),
    h('fieldset', {},
      h('legend', {}, '冬季係數（開車時間 ×）'),
      h('div', { class: 'row' },
        h('label', { class: 'row' }, '統一數值', winterIn),
        h('label', { class: 'row' }, winterPerDayCb, '每天個別設定')),
      winterTable),
    h('fieldset', {}, h('legend', {}, '每日包車時數'), charterTable),
    h('fieldset', {}, h('legend', {}, '預設起點（Day 1 第一點）'), startBox),
    h('fieldset', {}, h('legend', {}, '預設終點（最後一天最後一點）'), endBox),
    !isNew ? h('div', { class: 'small muted' }, '預設起訖點只影響之後新建的空白規劃。') : null,
    !isNew && admin ? h('fieldset', { class: 'admin-only' },
      h('legend', {}, '擁有帳號（管理員）'),
      h('div', { class: 'small muted' }, `目前：${oldOwner ? accountTitle(oldOwner) : '未歸屬'}。轉移後只有新的擁有帳號與管理員看得到這個專案。請確認帳號已在 Firebase Authentication 建立。`),
      ownerPick.el,
      h('div', { class: 'row' },
        h('button', { onClick: openCopyDialog, title: '把整個專案（設定、規劃、專案備用庫、路線快取）複製一份給指定帳號' }, '複製到其他帳號'),
        h('span', { class: 'small muted' }, '原專案保留不變；歷史快照不複製'))) : null,
    !isNew && onDeleted ? h('fieldset', { class: 'danger-zone' },
      h('legend', {}, '刪除專案'),
      h('div', { class: 'small muted' }, '會一併刪除所有規劃、歷史紀錄、路線快取與專案備用庫，無法復原。'),
      h('button', { class: 'danger', onClick: removeProject }, '刪除專案')) : null,
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
      winterPerDay,
      winterFactorsByDay: winterPerDay ? winterByDay.slice(0, Math.round(num(daysIn.value, 0))) : null,
      charterHoursByDay: charterHours.slice(0, Math.round(num(daysIn.value, 0))),
      defaultCharterHours: project?.defaultCharterHours ?? 10,
      latestEndTime: latestIn.value || '20:00',
      defaultStart, defaultEnd,
    };
    if (!data.name) return toast('請輸入專案名稱', 'warn');
    if (!bounds) return toast('請設定地圖範圍', 'warn');
    if (!data.startDate) return toast('請選擇開始日期', 'warn');
    if (!(data.numDays >= 1 && data.numDays <= 30)) return toast('天數需在 1–30 之間', 'warn');
    if (!(data.winterFactor > 0)) return toast('冬季係數需大於 0', 'warn');
    if (data.winterPerDay && data.winterFactorsByDay.some(v => !(v > 0))) return toast('每天的冬季係數需大於 0', 'warn');
    if (canEditBounds) data.bounds = bounds;
    // 管理員轉移擁有帳號：轉移前確認
    if (!isNew && admin) {
      const newOwner = ownerPick.get();
      if (newOwner == null) return toast('擁有帳號格式不正確（選「其他…」時請輸入帳號名稱）', 'warn');
      if (newOwner !== oldOwner) {
        const msg = `把專案「${project.name}」的擁有帳號\n從「${oldOwner || '未歸屬'}」轉移給「${newOwner || '未歸屬'}」？\n` +
          (newOwner ? `轉移後只有 ${newOwner} 與管理員看得到這個專案。` : '改為未歸屬後只有管理員看得到這個專案。');
        if (!(await confirmDialog(msg, '轉移'))) return;
        data.ownerEmail = newOwner;
      }
    }
    try {
      if (isNew) {
        const id = await createProject({ ...data, creatorNickname: state.nickname }, { ownerEmail });
        toast('專案已建立', 'ok'); close(); onSaved?.(id);
      } else {
        await updateProject(project.id, data);
        toast('專案設定已儲存', 'ok'); close(); onSaved?.(project.id, data);
      }
    } catch (e) { toast('儲存失敗：' + e.message, 'error'); }
  }

  /** 管理員：複製專案到其他帳號（以雲端上的原專案為準；這個視窗尚未儲存的修改不會帶過去） */
  async function openCopyDialog() {
    const targetPick = accountPicker({ value: '' });
    const nameIn = h('input', { type: 'text', class: 'full', value: project.name });
    const m = openModal({
      title: '複製專案到其他帳號',
      body: h('div', {},
        h('label', { class: 'row col' }, '目標帳號', targetPick.el),
        h('label', { class: 'row col' }, '新專案名稱', nameIn),
        h('div', { class: 'small muted' }, '複製內容：專案設定、所有規劃（含行程點、交通設定）、備用庫、路線快取。歷史快照不複製。目標帳號可以和原帳號相同。')),
      actions: [{ label: '取消', value: null }, { label: '下一步', value: 'ok', class: 'primary' }],
    });
    if ((await m.result) !== 'ok') return;
    const target = targetPick.get();
    const name = nameIn.value.trim() || project.name;
    if (!target) { toast('請選擇目標帳號（選「其他…」時請輸入正確的帳號名稱）', 'warn'); return; }
    const who = accountTitle(target);
    if (!(await confirmDialog(`把專案「${project.name}」複製一份到 ${who}？原專案保留不變。\n請確認帳號名稱正確，打錯的話只有管理員看得到這份複本`, '複製'))) return;

    // 複製中：顯示進度（不能中途關閉）
    const progress = h('div', { class: 'copy-progress' }, '準備中…');
    const pm = openModal({ title: `複製到 ${who}`, body: progress, actions: [], dismissValue: null });
    // 複製中不能點外面關閉，也不顯示右上角 ✕
    pm.el.closest('.modal-overlay').addEventListener('mousedown', (ev) => ev.stopImmediatePropagation(), true);
    pm.el.querySelector('.modal-head .icon-btn')?.remove();
    try {
      const newId = await copyProjectTo(project.id, { ownerEmail: target, name }, (t) => { progress.textContent = t; });
      pm.close();
      toast(`已複製到 ${who}`, 'ok', 5000);
      close();   // 關閉專案設定，讓首頁直接看到新專案
      onCopied?.(newId, target);
    } catch (e) {
      console.error(e);
      progress.replaceChildren(
        h('p', { class: 'error' }, '複製失敗：' + e.message),
        e.partialId
          ? h('p', { class: 'small' }, `已建立一份不完整的複本「${name}」（在首頁 ${who} 群組）。請到該複本的「專案設定」刪除後再重試。`)
          : h('p', { class: 'small' }, '尚未建立任何資料，可以直接重試。'),
        h('div', { class: 'row end' }, h('button', { class: 'primary', onClick: () => { pm.close(); if (e.partialId) onCopied?.(e.partialId, target); } }, '關閉')));
    }
  }

  async function removeProject() {
    const v = await promptDialog(`刪除專案：請輸入專案名稱「${project.name}」確認`, '', project.name);
    if (v == null) return;
    if (v !== project.name) { toast('名稱不符，已取消刪除', 'warn'); return; }
    const btn = form.querySelector('.danger-zone button');
    btn.disabled = true;
    try {
      // 先刪子集合（規劃與歷史、路線快取、專案備用庫），最後才刪專案本身
      await deleteProject(project.id, (t) => { btn.textContent = t; });
      toast(`已刪除專案「${project.name}」`, 'ok');
      close(); onDeleted?.(project.id);
    } catch (e) {
      console.error(e);
      toast('刪除失敗：' + e.message + '（已刪除的部分無法復原，可再按一次刪除剩下的資料）', 'error', 8000);
      btn.disabled = false; btn.textContent = '刪除專案';
    }
  }
}

// 匯出：純文字行程表、匯入格式（可直接匯入、完整還原）、JSON、Google 地圖（KML＋每天導航連結）
import { state, TYPE_LABEL, MODE_LABEL, dayCharterHours, prevPoint } from './state.js?v=2026-11-10-1';
import { computeSchedule } from './schedule.js?v=2026-11-10-1';
import { stopLabelMap } from './markers.js?v=2026-11-10-1';
import { buildKML, daysWithStops, dayNavLinks } from './gmaps-export.js?v=2026-11-10-1';
import { h, openModal, copyText, downloadFile, fmtHM, fmtDur, fmtDist, fmtDate, clone, toast } from './utils.js?v=2026-11-10-1';
import { toImportText } from './text-format.js?v=2026-11-10-1';
import { getLibrary } from './store.js?v=2026-11-10-1';

const WAYPOINT_LIMIT = { desktop: 9, mobile: 3 };

export function planToJSON() {
  const p = state.plan;
  return JSON.stringify({
    project: { name: state.project.name, startDate: state.project.startDate, numDays: state.project.numDays },
    plan: clone({ name: p.name, creator: p.creator, lastEditor: p.lastEditor, updatedAt: p.updatedAt, days: p.days }),
    library: clone({ tabs: state.library?.tabs || [] }),   // 專案備用庫（所有規劃共用）
  }, null, 2);
}

export function planToText() {
  const p = state.plan, proj = state.project;
  const sched = computeSchedule(p, proj);
  const labels = stopLabelMap(p);
  const nav = dayNavLinks(WAYPOINT_LIMIT.desktop);
  const L = [`${proj.name}｜${p.name}`, ''];
  p.days.forEach((day, di) => {
    const sd = sched[di];
    const charter = day.charter ? `包車上限 ${dayCharterHours(di) ?? '—'} 小時` : '不包車';
    L.push(`■ Day ${di + 1}  ${fmtDate(day.date)}  ${charter}`);
    const origin = !sd.isTripStart ? prevPoint(p, di, 0) : null;
    if (origin) L.push(`  [起點 ${labels.get(origin.id) || TYPE_LABEL[origin.type]}] ${origin.name}  ${day.departTime} 出發${origin.type !== 'hotel' ? '  ⚠ 前一天尚未安排住宿' : ''}`);
    day.stops.forEach((s, i) => {
      const st = sd.stops[i];
      if (st.leg) {
        const d = st.leg;
        let t = d.minutes != null ? fmtDur(d.minutes) : '時間未定';
        if (d.source === 'manual') t += '（手動）';
        else if (s.leg.mode === 'drive' && d.gMin != null) t += `（Google ${fmtDur(d.gMin)} × ${d.winter}）`;
        const dist = d.distance != null ? ` ${fmtDist(d.distance)}` : '';
        L.push(`      ↓ ${MODE_LABEL[s.leg.mode]}${dist} ${t}`);
      }
      const tag = labels.get(s.id) || TYPE_LABEL[s.type];
      let time;
      if (st.arr == null) time = `${fmtHM(st.dep)} 出發`;
      else if (s.type === 'hotel') time = `${fmtHM(st.arr)} 抵達`;
      else time = `${fmtHM(st.arr)}–${fmtHM(st.dep)}（停留 ${s.stayMin} 分）`;
      L.push(`  [${tag}] ${s.name}  ${time}${s.note ? `  ※${s.note}` : ''}`);
    });
    L.push(`  ── 總里程 ${fmtDist(sd.totalDist)}｜交通 ${fmtDur(sd.travelMin)}｜結束 ${sd.end != null ? fmtHM(sd.end) : '—'}${day.charter ? `｜包車 ${fmtDur(sd.charterMin)}` : ''}`);
    sd.warnings.forEach(w => L.push(`  ⚠ ${w.text}`));
    const segs = nav[di].segments;
    segs.forEach((g, k) => L.push(`  Google Maps 導航${segs.length > 1 ? `（第 ${k + 1} 段）` : ''}：${g.url}`));
    L.push('');
  });
  const tabs = (state.library?.tabs || []).filter(t => t.items.length);
  if (tabs.length) {
    L.push('■ 備用庫（專案共用）');
    tabs.forEach(t => L.push(`  ${t.name}：${t.items.map(i => i.name).join('、')}`));
  }
  return L.join('\n');
}

const safeName = (s) => (s || 'plan').replace(/[\\/:*?"<>|]/g, '_');

function googlePanel() {
  const base = safeName(state.plan.name);
  const days = daysWithStops();

  const downloadAll = () => {
    if (!days.length) return toast('行程中還沒有點', 'warn');
    downloadFile(`${base}.kml`, buildKML(days, state.plan.name), 'application/vnd.google-earth.kml+xml');
  };
  const downloadEach = async () => {
    if (!days.length) return toast('行程中還沒有點', 'warn');
    for (const di of days) {
      downloadFile(`${base}_Day${di + 1}.kml`, buildKML([di], `${state.plan.name} Day ${di + 1}`), 'application/vnd.google-earth.kml+xml');
      await new Promise(r => setTimeout(r, 400));   // 間隔下載，避免瀏覽器擋掉
    }
    toast(`已下載 ${days.length} 個檔案（若瀏覽器詢問「允許下載多個檔案」請按允許）`, 'ok', 6000);
  };

  // 導航連結：網頁版與 App 最多 9 個中途點；手機瀏覽器最多 3 個
  let limitKey = 'desktop';
  const linksBox = h('div', { class: 'nav-links' });
  const renderLinks = () => {
    const nav = dayNavLinks(WAYPOINT_LIMIT[limitKey]);
    linksBox.replaceChildren(...nav.map(({ di, segments }) => h('div', { class: 'nav-day' },
      h('strong', {}, `Day ${di + 1} ${fmtDate(state.plan.days[di].date)}`),
      segments.length ? segments.map((g, k) => h('div', { class: 'nav-seg' },
        h('a', { href: g.url, target: '_blank', rel: 'noopener' },
          `${segments.length > 1 ? `第 ${k + 1} 段：` : ''}${g.from} → ${g.to}（${g.n} 點）`),
        h('button', { class: 'small-btn', onClick: () => copyText(g.url) }, '複製')))
        : h('span', { class: 'muted small' }, '　點數不足，無連結'))));
  };
  const limitSel = h('select', { onChange: (e) => { limitKey = e.target.value; renderLinks(); } },
    h('option', { value: 'desktop' }, '電腦網頁／手機 App（每段最多 9 個中途點）'),
    h('option', { value: 'mobile' }, '手機瀏覽器（每段最多 3 個中途點）'));
  renderLinks();

  return h('div', { class: 'gm-export' },
    h('h4', {}, '① KML（匯入 Google 我的地圖）'),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onClick: downloadAll }, `全部天數一個檔（${base}.kml）`),
      h('button', { onClick: downloadEach }, `每天各一個檔（${base}_Day1.kml …）`)),
    h('ul', { class: 'small help' },
      h('li', {}, '「我的地圖」每次匯入一個檔案會放進一個圖層；KML 裡的資料夾（每天一個 Folder）不會變成各自的圖層。'),
      h('li', {}, h('strong', {}, '全部天數一個檔'), '：一次匯入，所有天數在同一個圖層，用顏色區分天數。適合快速看全貌。'),
      h('li', {}, h('strong', {}, '每天各一個檔'), '：每天建立一個圖層、各匯入一個檔，之後可以勾選只顯示某一天。適合旅行中逐日查看。單天檔案會包含當天的起點。'),
      h('li', {}, '匯入後，各類型的圖示可能會換成「我的地圖」內建的相近圖示；每天的顏色通常會保留。單一 KML 檔上限 5 MB。')),
    h('h4', {}, '② 每天的 Google Maps 導航連結（開車）'),
    h('div', { class: 'row small' }, '中途點上限：', limitSel),
    linksBox,
    h('div', { class: 'small muted' }, '中途點超過上限時會自動拆成多段，前一段的終點就是下一段的起點。'),
    h('h4', {}, '③ 怎麼在 Google 地圖上看'),
    h('ol', { class: 'small help' },
      h('li', {}, '電腦開啟 ', h('a', { href: 'https://www.google.com/maps/d/', target: '_blank', rel: 'noopener' }, 'Google 我的地圖（google.com/maps/d/）'), '，按「建立新地圖」。'),
      h('li', {}, '在左側圖層按「匯入」，選擇下載的 KML 檔。要每天一個圖層時，先按「新增圖層」，再對每個圖層各匯入一天的檔案。'),
      h('li', {}, '手機開啟 Google 地圖 App（登入同一個 Google 帳號），點下方「已儲存」→ 往下找到「地圖」，就能看到這張地圖（需要網路連線）。')));
}

/** 匯入格式：專案設定、規劃、本規劃備用庫、專案備用庫（規劃畫面已即時訂閱專案備用庫；還沒載入時先讀取） */
export async function planToImportText() {
  const library = state.library || await getLibrary(state.project.id);
  return toImportText({ project: state.project, plan: state.plan, library });
}

export function openExport() {
  const base = `${safeName(state.project.name)}_${safeName(state.plan.name)}`;
  const area = h('textarea', { class: 'export-area', readonly: true });
  const textBox = h('div', {}, area,
    h('div', { class: 'row end' },
      h('button', { onClick: () => copyText(area.value) }, '複製'),
      h('button', { class: 'primary', onClick: () => mode === 'json'
        ? downloadFile(base + '.json', area.value, 'application/json')
        : downloadFile(base + (mode === 'import' ? '_匯入格式' : '') + '.txt', area.value) }, '下載')));
  const importHint = h('div', { class: 'small muted' },
    '這份文字可以在首頁「匯入成新專案」或專案內「匯入行程」直接匯入，完整還原專案設定、行程、備用庫與專案備用庫。地點以地點 ID 與座標記錄，匯入時不必重新搜尋。');
  const gBox = googlePanel();
  let mode = 'text';
  const show = async () => {
    textBox.classList.toggle('hidden', mode === 'google');
    gBox.classList.toggle('hidden', mode !== 'google');
    importHint.classList.toggle('hidden', mode !== 'import');
    if (mode === 'text') area.value = planToText();
    if (mode === 'json') area.value = planToJSON();
    if (mode === 'import') {
      area.value = '產生中…';
      try { area.value = await planToImportText(); } catch (e) { area.value = '產生失敗：' + e.message; }
    }
  };
  const tabBtn = (m, label) => h('button', { class: 'chip' + (mode === m ? ' active' : ''), onClick: (e) => {
    mode = m; show();
    e.target.parentElement.querySelectorAll('.chip').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
  } }, label);
  const body = h('div', {},
    h('div', { class: 'row' }, tabBtn('text', '純文字行程表'), tabBtn('import', '匯出成匯入格式'), tabBtn('json', 'JSON'), tabBtn('google', 'Google 地圖（KML／導航）')),
    importHint, textBox, gBox);
  show();
  openModal({ title: '匯出', body, wide: true });
}

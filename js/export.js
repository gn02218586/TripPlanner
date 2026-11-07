// 匯出：JSON 與純文字行程表（複製＋下載）
import { state, TYPE_LABEL, MODE_LABEL, dayCharterHours } from './state.js';
import { computeSchedule } from './schedule.js';
import { stopLabelMap } from './markers.js';
import { h, openModal, copyText, downloadFile, fmtHM, fmtDur, fmtDist, fmtDate, clone } from './utils.js';

export function planToJSON() {
  const p = state.plan;
  return JSON.stringify({
    project: { name: state.project.name, startDate: state.project.startDate, numDays: state.project.numDays },
    plan: clone({ name: p.name, creator: p.creator, lastEditor: p.lastEditor, updatedAt: p.updatedAt, days: p.days, backup: p.backup }),
  }, null, 2);
}

export function planToText() {
  const p = state.plan, proj = state.project;
  const sched = computeSchedule(p, proj);
  const labels = stopLabelMap(p);
  const L = [`${proj.name}｜${p.name}`, ''];
  p.days.forEach((day, di) => {
    const sd = sched[di];
    const charter = day.charter ? `包車上限 ${dayCharterHours(day) ?? '—'} 小時` : '不包車';
    L.push(`■ Day ${di + 1}  ${fmtDate(day.date)}  出發 ${day.departTime}  ${charter}`);
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
    L.push('');
  });
  const tabs = p.backup.tabs.filter(t => t.items.length);
  if (tabs.length) {
    L.push('■ 備用庫');
    tabs.forEach(t => L.push(`  ${t.name}：${t.items.map(i => i.name).join('、')}`));
  }
  return L.join('\n');
}

export function openExport() {
  const safe = (s) => (s || 'plan').replace(/[\\/:*?"<>|]/g, '_');
  const base = `${safe(state.project.name)}_${safe(state.plan.name)}`;
  const area = h('textarea', { class: 'export-area', readonly: true });
  let mode = 'text';
  const fill = () => { area.value = mode === 'text' ? planToText() : planToJSON(); };
  const tabBtn = (m, label) => h('button', { class: 'chip' + (mode === m ? ' active' : ''), onClick: (e) => {
    mode = m; fill(); e.target.parentElement.querySelectorAll('.chip').forEach(b => b.classList.remove('active')); e.target.classList.add('active');
  } }, label);
  const body = h('div', {},
    h('div', { class: 'row' }, tabBtn('text', '純文字行程表'), tabBtn('json', 'JSON')),
    area,
    h('div', { class: 'row end' },
      h('button', { onClick: () => copyText(area.value) }, '複製'),
      h('button', { class: 'primary', onClick: () => mode === 'text'
        ? downloadFile(base + '.txt', area.value)
        : downloadFile(base + '.json', area.value, 'application/json') }, '下載')));
  fill();
  openModal({ title: '匯出', body, wide: true });
}

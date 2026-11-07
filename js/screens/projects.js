// 選專案：列出所有專案、新建專案、初始化測試資料
import { listProjects } from '../store.js';
import { runSeed } from '../seed.js';
import { h, fmtDate, fmtDateTime, toast } from '../utils.js';
import { openProjectForm } from './project-form.js';
import { topBar } from './common.js';

export async function mountProjects(app) {
  const list = h('div', { class: 'list' }, h('div', { class: 'muted' }, '載入中…'));
  const page = h('div', { class: 'page' },
    topBar([h('strong', {}, '選擇專案')]),
    h('div', { class: 'page-body' },
      h('div', { class: 'row' },
        h('button', { class: 'primary', onClick: () => openProjectForm({ onSaved: (id) => { location.hash = `#/p/${id}`; } }) }, '＋ 新建專案'),
        h('button', { onClick: async () => {
          try { const id = await runSeed(); if (id) load(); } catch (e) { toast('初始化失敗：' + e.message, 'error'); }
        } }, '初始化測試資料（北海道測試）')),
      list));
  app.replaceChildren(page);

  async function load() {
    try {
      const projects = await listProjects();
      list.replaceChildren(...(projects.length ? projects.map(p => h('a', { class: 'card list-item', href: `#/p/${p.id}` },
        h('div', { class: 'li-title' }, p.name),
        h('div', { class: 'small muted' },
          `${fmtDate(p.startDate)} 起 ${p.numDays} 天・建立者 ${p.creatorNickname || '—'}・${fmtDateTime(p.createdAt)}`)))
        : [h('div', { class: 'muted' }, '還沒有專案，請新建或初始化測試資料。')]));
    } catch (e) {
      list.replaceChildren(h('div', { class: 'error' }, '讀取失敗：' + e.message));
    }
  }
  load();
  return () => {};
}

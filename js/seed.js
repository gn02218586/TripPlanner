// 種子資料：「北海道測試」專案（已存在就不重複建立）
import { state, blankPlanData } from './state.js';
import { findProjectByName, createProject, createPlan } from './store.js';
import { toast } from './utils.js';

const SEED_NAME = '北海道測試';

export async function runSeed() {
  const exists = await findProjectByName(SEED_NAME);
  if (exists) { toast(`已存在名為「${SEED_NAME}」的專案，不重複建立`, 'warn', 5000); return null; }

  const project = {
    name: SEED_NAME,
    creatorNickname: state.nickname,
    bounds: { n: 44.8, s: 42.3, e: 146.0, w: 141.9 },
    startDate: '2027-02-15',
    numDays: 6,
    defaultMode: 'drive',
    winterFactor: 1.3,
    defaultCharterHours: 10,
    latestEndTime: '20:00',
    defaultStart: { name: '釧路機場', placeId: null, lat: 43.0411, lng: 144.1928, type: 'airport' },
    defaultEnd: { name: '女滿別機場', placeId: null, lat: 43.8806, lng: 144.1642, type: 'airport' },
  };
  const pid = await createProject(project);

  // 範例規劃：每天包車；2/15 與 2/20 上限 8 小時（其他天沿用專案 10 小時）；Day 1 出發 09:15
  const data = blankPlanData(project);
  data.days[0].departTime = '09:15';
  data.days[0].charterHours = 8;
  data.days[5].charterHours = 8;
  data.days.forEach(d => { d.charter = true; });
  await createPlan(pid, { name: '範例規劃', ...data });
  toast(`已建立「${SEED_NAME}」專案與範例規劃`, 'ok');
  return pid;
}

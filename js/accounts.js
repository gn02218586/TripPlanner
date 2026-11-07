// 帳號設定與工具：一個帳號代表一團人；管理員可看到全部專案
// ※ 管理員 Email 也寫在 firestore.rules 的 isAdmin()，修改時兩處要一致
import { state } from './state.js';

/** 帳號沒有「@」時自動補上的網域 */
export const ACCOUNT_DOMAIN = 'tripplanner.app';
/** 管理員帳號（登入時輸入 gn02218586） */
export const ADMIN_EMAIL = 'gn02218586@tripplanner.app';

/** 使用者輸入的帳號 → 登入用 Email（小寫；沒有 @ 補上網域） */
export function toEmail(input) {
  const v = String(input || '').trim().toLowerCase();
  if (!v) return '';
  return v.includes('@') ? v : `${v}@${ACCOUNT_DOMAIN}`;
}

/** 帳號名稱：Email 的 @ 前面那段 */
export const accountName = (email) => String(email || '').split('@')[0];

/** 群組標題等需要辨識帳號的地方：本站網域只顯示帳號名稱，其他網域顯示完整 Email */
export const accountLabel = (email) =>
  String(email || '').toLowerCase().endsWith('@' + ACCOUNT_DOMAIN) ? accountName(email) : String(email || '');

export const isAdminEmail = (email) => String(email || '').toLowerCase() === ADMIN_EMAIL;

/** 目前登入帳號的 Email（小寫） */
export const currentEmail = () => String(state.user?.email || '').toLowerCase();
export const isAdmin = () => isAdminEmail(currentEmail());

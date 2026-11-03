/**
 * 招聘页门禁：纯函数，无 chrome 依赖，方便单测复用。
 *
 * 白名单制（宁可放行、不误杀）：命中任一条即视为招聘页。
 * 1. 首段子域命中招聘子域表（job./careers./campus. …）；
 * 2. 去掉首段 www 后的 hostname 命中招聘平台表（Boss 直聘这类平台都走这条）；
 * 3. pathname 含招聘路径关键字（兜 www.company.com/careers 这类官网招聘页）。
 *
 * 注意：平台表/子域表/关键字以后由设置页接管（用户可增删），规则函数签名保持不变。
 */

/** 招聘平台域名表：以后由设置页接管，用户可增删。 */
export const RECRUIT_PLATFORM_HOSTS = [
  'zhipin.com', // Boss 直聘
  'lagou.com', // 拉勾
  '51job.com', // 前程无忧
  'liepin.com', // 猎聘
  'linkedin.com', // 领英
  '104.com.tw', // 104 人力银行
  '1111.com.tw', // 1111 人力银行
  'ganji.com', // 赶集
  'poizon.jobs.feishu.cn', // 得物 App 校园招聘（飞书招聘页面）
  'jobs.feishu.cn', // 飞书招聘 SaaS 的企业校园/社会招聘页面
];

/** 招聘子域首段表：job.example.com / careers.example.com 这类。 */
export const RECRUIT_SUBDOMAINS = [
  'job',
  'jobs',
  'career',
  'careers',
  'join',
  'hr',
  'zhaopin',
  'talent',
  'campus',
  'recruit',
  'recruiting',
];

/** 招聘路径关键字（大小写不敏感）：www.company.com/careers 这类官网招聘页。 */
export const RECRUIT_PATH_KEYWORDS = ['career', 'job', 'zhaopin', 'join', 'recruit', 'campushire'];

export function isRecruitingPage(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  const parts = host.split('.').filter(Boolean);
  const noWww = parts[0] === 'www' ? parts.slice(1).join('.') : host;
  if (RECRUIT_PLATFORM_HOSTS.some((h) => noWww === h || noWww.endsWith('.' + h))) return true;
  if (RECRUIT_SUBDOMAINS.includes(parts[0])) return true;
  const path = (parsed.pathname + parsed.search + parsed.hash).toLowerCase();
  if (RECRUIT_PATH_KEYWORDS.some((k) => path.includes(k))) return true;
  return false;
}

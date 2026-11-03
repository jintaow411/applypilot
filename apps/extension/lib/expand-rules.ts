/**
 * 折叠展开站点登记表（registry）：站点穷举登记 + 通用兜底。
 *
 * 为什么：通用启发式（看文案/看 cursor/看箭头图猜开关）在 Angular 老站上迟早点错，
 * 点错一次就是跳页/提交/删除且无法撤销。所以改成“先查表再兜底”：
 * 命中规则的站只点规则里登记的选择器，无规则的站才走通用启发式。
 *
 * 以后加站三步：
 * 1. 存档 html——把问题页另存为仓库根的 test-*.html（勿删，作回归凭据）；
 * 2. 找开关选择器——在存档里定位折叠块根（如 div[id^=subGroup_]）和“点开面板”的
 *    开关元素（如 img.up-down-img / .mdf-tit），只认展开开关，外链/submit/删除一律排除；
 * 3. 加一条——在 EXPAND_RULES 追加 {id, hostSuffix, toggles, scope}，toggles 按点击优先级排。
 *
 * 约束：纯函数、无 chrome 依赖、可注入页面；matchExpandRule 零依赖（只做字符串处理），
 * 可被 page.evaluate 序列化进页面，也可在 node 里直接断言。
 */
export interface ExpandRule {
  /** 站点 id，如 chinatelecom-job */
  id: string;
  /** host 后缀，如 job.chinatelecom.com.cn（子串后缀匹配，大小写不敏感） */
  hostSuffix: string;
  /** 开关选择器，按点击优先级排，如 ['img.up-down-img', '.mdf-tit'] */
  toggles: string[];
  /** 块根选择器（可选），如 div[id^=subGroup_]；不填则以通用块根为准 */
  scope?: string;
}

export const EXPAND_RULES: ExpandRule[] = [
  {
    id: 'chinatelecom-job',
    hostSuffix: 'job.chinatelecom.com.cn',
    toggles: ['img.up-down-img', '.mdf-tit'],
    scope: 'div[id^=subGroup_]',
  },
];

/** 从 url 里抠 host：带协议取 :// 到下一个 / 之间，不带协议取第一个 / 之前；去端口、去首尾点、小写。 */
function hostOf(url: string): string {
  let s = String(url || '').trim().toLowerCase();
  const proto = s.indexOf('://');
  if (proto >= 0) s = s.slice(proto + 3);
  const slash = s.indexOf('/');
  if (slash >= 0) s = s.slice(0, slash);
  const at = s.lastIndexOf('@');
  if (at >= 0) s = s.slice(at + 1);
  const colon = s.indexOf(':');
  if (colon >= 0) s = s.slice(0, colon);
  while (s.charAt(s.length - 1) === '.') s = s.slice(0, -1);
  return s;
}

/**
 * 按 host 长后缀优先命中一条规则：host 等于 hostSuffix，或以 '.' + hostSuffix 结尾。
 * 无命中回 null（调用方走通用启发式兜底）。rules 默认为 EXPAND_RULES，传参可测优先级。
 */
export function matchExpandRule(url: string, rules?: ExpandRule[]): ExpandRule | null {
  const list = rules || EXPAND_RULES;
  const host = hostOf(url);
  if (!host) return null;
  let best: ExpandRule | null = null;
  for (const r of list) {
    const suffix = String((r && r.hostSuffix) || '').trim().toLowerCase();
    if (!suffix) continue;
    if (host !== suffix && host.slice(-suffix.length - 1) !== '.' + suffix) continue;
    if (!best || suffix.length > String(best.hostSuffix).length) best = r;
  }
  return best;
}

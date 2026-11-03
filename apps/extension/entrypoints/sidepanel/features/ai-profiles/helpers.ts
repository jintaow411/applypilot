import { hostOfUrl, type AIProfile } from '../../../../lib/ai';

/** 名称自动取 Base URL 的 host；列表展示「名称-模型 id」，不再展示协议。 */
export function displayProfileName(profile: AIProfile): string {
  return hostOfUrl(profile.baseUrl) || profile.name || '新配置';
}

export function profileLabel(profile: AIProfile): string {
  return `${displayProfileName(profile)} - ${profile.model || '未选模型'}`;
}

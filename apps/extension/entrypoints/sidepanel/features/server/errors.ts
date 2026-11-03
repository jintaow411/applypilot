import { ApiError, DEFAULT_BASE_URL } from '../../../../lib/api';
import type { NoticeAction } from '../schema/types';

export const STORAGE_KEYS = {
  baseUrl: 'autoInfo.baseUrl',
  token: 'autoInfo.token',
} as const;

export interface ServerSettings {
  baseUrl: string;
  token: string;
}

export const DEFAULT_SERVER: ServerSettings = {
  baseUrl: DEFAULT_BASE_URL,
  token: '',
};

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * 服务端统一错误包 {ok:false, code, message} 的 code 提取。
 * lib/api.ts 不动，只能在这里从 ApiError 身上抠：body 是 envelope 原文（优先），
 * message 里嵌着截断版（正则兜底），最后按 HTTP 状态回退。调不通（status 0）返回 null。
 */
export function serverCodeOf(error: unknown): string | null {
  const record = error as { body?: unknown; status?: unknown; message?: string } | null;
  const candidates: unknown[] = [record?.body];
  if (typeof record?.message === 'string') candidates.push(record.message);
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate) continue;
    const direct = /"code"\s*:\s*"([a-z_]+)"/.exec(candidate)?.[1];
    if (direct) return direct;
    try {
      const parsed = JSON.parse(candidate) as { code?: unknown };
      if (typeof parsed.code === 'string' && parsed.code) return parsed.code;
    } catch {
      /* 不是完整 JSON，试下一处 */
    }
  }
  const status = record?.status;
  if (status === 401) return 'unauthorized';
  if (status === 400) return 'bad_request';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 413) return 'payload_too_large';
  if (typeof status === 'number' && status >= 500) return 'storage_error';
  return null;
}

/** 服务端 envelope 里的人话 message（抠不到返回 null，调用方用原文兜底）。 */
export function serverMessageOf(error: unknown): string | null {
  const record = error as { body?: unknown; message?: string } | null;
  const candidates: unknown[] = [record?.body, record?.message];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as { message?: unknown; error?: unknown };
      if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim();
      if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim();
    } catch {
      /* message 里是截断版 envelope，JSON.parse 注定失败，跳过（code 照样能正则抠到） */
    }
  }
  return null;
}

/**
 * code → 提示条映射（上报 / 填入两条链路共用；拉适配的 code 由 background 透下后直接展示人话）:
 * - unauthorized → 去配对页重贴 token（附跳转按钮，不给重试）；
 * - payload_too_large → 页面过大，精简后上报（服务端人话 + 重试）；
 * - storage_error / 调不通（无 code）/ bad_request / not_found / forbidden → 人话 + 重试；
 * - 填入链路的英文连接错误（content script 未就绪）翻译成中文 + 重试。
 */
export function friendlyNotice(
  error: unknown,
  retryLabel: string,
  onRetry: () => void,
  onPair: () => void,
): { text: string; action?: NoticeAction } {
  if (serverCodeOf(error) === 'unauthorized') {
    return {
      text:
        serverMessageOf(error) ||
        '配对失败：服务端不认这个 token，请去配对页重贴服务端启动时打印的 token。',
      action: { label: '去配对', run: onPair },
    };
  }
  const raw = errorText(error);
  if (/Could not establish connection|Receiving end does not exist/i.test(raw)) {
    return {
      text: '页面脚本未就绪：请刷新当前页面后重试。',
      action: { label: retryLabel, run: onRetry },
    };
  }
  return { text: serverMessageOf(error) || raw, action: { label: retryLabel, run: onRetry } };
}

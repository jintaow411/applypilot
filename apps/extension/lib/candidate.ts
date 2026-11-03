/**
 * 候选人信息库（精简纯文本）的插件端上传 / 校验 / 本地存取。
 *
 * 存储形状（chrome.storage.local，CANDIDATE_KEY 不变）：
 * - CANDIDATE_KEY 存 { text }（包一层对象，留扩展位，不裸存字符串），
 * - CANDIDATE_META_KEY 存 { updatedAt } 更新时间。
 * 开源使用者请通过侧边栏上传自己的资料；这里不放示例姓名、电话、邮箱或简历文本。
 * background 的 handleAICall 只认 CANDIDATE_KEY 里用户上传的文本，没有就不调 AI
 * （不用打包示例数据兜底，避免拿别人的信息去填表），
 * 回填时存的文本原样发给 AI，不再经 buildProfileText 转换。
 * 老数据兼容：读到旧形状（含 fields 数组的 JSON）就用 buildProfileText 转成文本、
 * 按新形状存回（自动迁移，用户字段不丢），state 照常 ready。
 */

import { buildProfileText } from './match.js';
import type { Profile } from './schema.js';

export const CANDIDATE_KEY = 'autoInfo.candidateProfile';
export const CANDIDATE_META_KEY = 'autoInfo.candidateProfileMeta';

/** 信息库文本最短长度（去空白后）：解析输出 / 手动保存低于此视为无效 */
export const MIN_CANDIDATE_TEXT_LENGTH = 20;

/** 单次送进 AI 的简历原文上限（字符）：多文件合并后超过就截断，与 lib/ai.ts 的上限保持一致 */
export const MAX_RESUME_TEXT_LENGTH = 30_000;

/** 一次最多暂存的文件数（再多合并后必超上限，也没法在侧边栏里看清） */
export const MAX_STAGED_FILES = 12;

/** 单个文件最大字节数：超过就别读了，mammoth/文本解析会把侧边栏卡死 */
export const MAX_RESUME_FILE_BYTES = 8 * 1024 * 1024;

/** 支持拖入的扩展名（不含点，小写）；.doc 会进列表但在读取时明确报错 */
export const SUPPORTED_RESUME_EXTS = ['txt', 'md', 'markdown', 'text', 'docx', 'doc'] as const;

export interface CandidateValidation {
  ok: boolean;
  errors: string[];
  text: string | null;
}

export interface CandidateStatus {
  /** loading: 还没读完 storage，此时绝不显示「未上传」；ready: 已有且合法；empty: 确实没有 */
  state: 'loading' | 'ready' | 'empty' | 'invalid';
  text: string | null;
  updatedAt: number | null;
  error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 文本长度校验：非空且去空白后不少于 MIN_CANDIDATE_TEXT_LENGTH，返回错误文案或 null */
function checkTextLength(text: string): string | null {
  if (!text.trim()) return '信息库文本为空';
  if (text.replace(/\s+/g, '').length < MIN_CANDIDATE_TEXT_LENGTH) {
    return '信息库文本太短（至少 ' + MIN_CANDIDATE_TEXT_LENGTH + ' 字有效内容）';
  }
  return null;
}

/**
 * 去 JSON 包装：模型在 json_object 协议下会被迫输出 JSON（如 {"type":"json_object","content":"…"}），
 * stripCodeFence 去不掉这层。这里把 JSON 串解出 content/text 等字段的纯文本；
 * 纯文本原样返回。最多解 3 层（content 里再套一层 JSON 的情况）。
 */
export function unwrapJsonWrappedText(input: string): string {
  let current = String(input ?? '');
  for (let i = 0; i < 3; i++) {
    const t = current.trim();
    if (!(t.startsWith('{') && t.endsWith('}'))) break;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      break;
    }
    if (typeof parsed === 'string') {
      current = parsed;
      continue;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      const keys = ['content', 'text', 'output', 'result', 'mergedText', 'profileText', 'profile', 'data', 'merged_text'];
      let hit: string | null = null;
      for (const k of keys) {
        if (typeof rec[k] === 'string' && String(rec[k]).trim()) {
          hit = String(rec[k]);
          break;
        }
      }
      if (hit !== null) {
        current = hit;
        continue;
      }
    }
    break;
  }
  return current;
}

/**
 * 取文本：新形状 { text } / 裸字符串直接取；旧形状（含 fields 数组的 JSON）经
 * buildProfileText 转成文本（migrated=true，调用方按新形状存回）；其余返回 null。
 * JSON 包装（{type,content} 串 / {text} 串 / {type,content} 对象）就地解包为纯文本
 * 并标记 migrated=true，调用方按新形状存回（坏数据读时自动修）。
 */
export function normalizeCandidateText(input: unknown): { text: string; migrated: boolean } | null {
  if (typeof input === 'string') {
    const unwrapped = unwrapJsonWrappedText(input);
    return { text: unwrapped.trim(), migrated: unwrapped.trim() !== input.trim() };
  }
  if (!isRecord(input)) return null;
  const rec = input as { text?: unknown; content?: unknown; output?: unknown; fields?: unknown };
  if (typeof rec.text === 'string') {
    const unwrapped = unwrapJsonWrappedText(rec.text);
    return { text: unwrapped.trim(), migrated: unwrapped.trim() !== rec.text.trim() };
  }
  // 直接存了 { type:'json_object', content:'…' } 对象的坏数据：解出 content 纯文本。
  if (typeof rec.content === 'string') {
    const unwrapped = unwrapJsonWrappedText(rec.content);
    return { text: unwrapped.trim(), migrated: true };
  }
  if (typeof rec.output === 'string') {
    const unwrapped = unwrapJsonWrappedText(rec.output);
    return { text: unwrapped.trim(), migrated: true };
  }
  if (Array.isArray(rec.fields)) {
    return { text: buildProfileText(input as unknown as Profile).trim(), migrated: true };
  }
  return null;
}

/** 校验信息库：新形状 / 裸字符串 / 旧 JSON（按迁移后文本计）均可，只做非空不太短校验 */
export function validateCandidateProfile(input: unknown): CandidateValidation {
  const got = normalizeCandidateText(input);
  if (!got) return { ok: false, errors: ['信息库须是文本（旧版 JSON 会自动迁移）'], text: null };
  const err = checkTextLength(got.text);
  if (err) return { ok: false, errors: [err], text: null };
  return { ok: true, errors: [], text: got.text };
}

interface StorageAreaLike {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

function storageArea(): StorageAreaLike | null {
  try {
    const area = (chrome as unknown as { storage?: { local?: unknown } }).storage?.local;
    if (!area) return null;
    return area as StorageAreaLike;
  } catch {
    return null;
  }
}

/** 读取本地信息库状态：storage 不可用 / 读失败按 invalid 处理；旧 JSON 自动迁移成文本存回 */
export async function loadCandidateStatus(): Promise<CandidateStatus> {
  const area = storageArea();
  if (!area) {
    return { state: 'invalid', text: null, updatedAt: null, error: '扩展 storage 不可用' };
  }
  let stored: Record<string, unknown>;
  try {
    stored = await area.get([CANDIDATE_KEY, CANDIDATE_META_KEY]);
  } catch (error) {
    return {
      state: 'invalid',
      text: null,
      updatedAt: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const raw = stored[CANDIDATE_KEY];
  if (raw === undefined || raw === null) {
    return { state: 'empty', text: null, updatedAt: null, error: null };
  }
  const got = normalizeCandidateText(raw);
  const err = got ? checkTextLength(got.text) : null;
  if (!got || err) {
    return {
      state: 'invalid',
      text: null,
      updatedAt: null,
      error: err || '已存数据格式不正确',
    };
  }
  if (got.migrated) {
    try {
      await area.set({ [CANDIDATE_KEY]: { text: got.text } });
    } catch {
      /* 迁移写回失败不影响本次读取 */
    }
  }
  const meta = stored[CANDIDATE_META_KEY];
  const updatedAt =
    isRecord(meta) && typeof meta.updatedAt === 'number' && Number.isFinite(meta.updatedAt)
      ? (meta.updatedAt as number)
      : null;
  return { state: 'ready', text: got.text, updatedAt, error: null };
}

/** 简历文件读取：txt/md 直接读文本；docx 用 mammoth 抽正文；旧版 .doc 不支持。 */
export async function readResumeFile(file: File): Promise<string> {
  const name = String(file.name || '').toLowerCase();
  if (/\.docx$/.test(name)) {
    const { extractRawText } = await import('mammoth');
    const buffer = await file.arrayBuffer();
    const result = await extractRawText({ arrayBuffer: buffer });
    const text = String(result?.value || '').replace(/\r/g, '').trim();
    if (!text) throw new Error('该 docx 里没有读到正文（可能是扫描件或纯图片）');
    return text;
  }
  if (/\.(txt|md|markdown|text)$/.test(name) || file.type.startsWith('text/')) {
    const text = String(await file.text()).replace(/\r/g, '').trim();
    if (!text) throw new Error('文件是空的，没有可解析的内容');
    return text;
  }
  if (/\.doc$/.test(name)) {
    throw new Error('旧版 .doc 打不开，请另存为 .docx / .txt / .md 后再拖入');
  }
  throw new Error('只支持 .txt / .md / .docx 三种文件');
}

/** 删除信息库：正文与更新时间一起清掉（暂存文件在内存里，不受影响）。 */
export async function clearCandidateText(): Promise<void> {
  const area = storageArea();
  if (!area) throw new Error('扩展 storage 不可用，无法删除信息库');
  await area.remove([CANDIDATE_KEY, CANDIDATE_META_KEY]);
}

/** 信息库文本存 storage（{ text } + 更新时间分开存），返回更新时间戳；JSON 包装串先解包，绝不把 JSON 串直接存入。 */
export async function saveCandidateText(text: string): Promise<number> {
  text = unwrapJsonWrappedText(String(text ?? '')).trim();
  const area = storageArea();
  if (!area) throw new Error('扩展 storage 不可用，无法保存信息库');
  const updatedAt = Date.now();
  await area.set({ [CANDIDATE_KEY]: { text: text }, [CANDIDATE_META_KEY]: { updatedAt } });
  return updatedAt;
}

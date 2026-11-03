import * as React from 'react';
import {
  MAX_RESUME_FILE_BYTES,
  MAX_RESUME_TEXT_LENGTH,
  MAX_STAGED_FILES,
  MIN_CANDIDATE_TEXT_LENGTH,
  SUPPORTED_RESUME_EXTS,
  clearCandidateText,
  loadCandidateStatus,
  readResumeFile,
  saveCandidateText,
  unwrapJsonWrappedText,
  validateCandidateProfile,
  type CandidateStatus,
} from '../../../../lib/candidate';
import { toast } from '../../../../components/ui/toast';
import { errorText } from '../server/errors';
import { sendToBackground } from '../schema/helpers';
import type { MergeMessage, ParseMessage } from '../schema/types';
import type { CandidateProgress, FilePreview, StagedFileItem } from './types';

export interface CandidateStreamState {
  streaming: boolean;
  text: string;
  error: string | null;
  title?: string;
}

const SUPPORTED_EXTS = new Set<string>(SUPPORTED_RESUME_EXTS);
const IDLE_PROGRESS: CandidateProgress = { active: false, percent: 0, label: '' };

function fileExt(name: string): string {
  const matched = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return matched ? matched[1]!.toLowerCase() : '';
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 有效字数：去掉所有空白后的长度，与信息库字数口径一致 */
function charCountOf(text: string): number {
  return text.replace(/\s+/g, '').length;
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
}

/** 简历拖拽入库：通过 Port 进行流式解析 */
async function parseResumeStream(
  text: string,
  onDelta: (delta: string, accumulated: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    let port: chrome.runtime.Port | null = null;
    let finished = false;

    try {
      port = chrome.runtime.connect({ name: 'AI_PARSE_STREAM' });
    } catch (err) {
      reject(err);
      return;
    }

    port.onDisconnect.addListener(() => {
      if (!finished) {
        const err = chrome.runtime.lastError?.message || '与后台脚本连接断开';
        reject(new Error(err));
      }
    });

    port.onMessage.addListener(
      (msg: { type: string; delta?: string; accumulated?: string; data?: unknown; error?: string }) => {
        if (msg.type === 'delta') {
          if (typeof msg.accumulated === 'string') {
            onDelta(msg.delta ?? '', msg.accumulated);
          }
        } else if (msg.type === 'done') {
          finished = true;
          try {
            port?.disconnect();
          } catch {
            /* 端口断开忽略 */
          }
          const raw = typeof msg.data === 'string' ? unwrapJsonWrappedText(msg.data) : msg.data;
          const checked = validateCandidateProfile(raw);
          if (checked.ok && checked.text) {
            resolve(checked.text);
          } else {
            reject(new Error(checked.errors.join('；') || 'AI 解析输出格式不正确'));
          }
        } else if (msg.type === 'error') {
          finished = true;
          try {
            port?.disconnect();
          } catch {
            /* 端口断开忽略 */
          }
          reject(new Error(msg.error || 'AI 解析失败'));
        }
      }
    );

    port.postMessage({
      type: 'AI_PARSE',
      text: text.slice(0, MAX_RESUME_TEXT_LENGTH),
    });
  });
}

/** 手动补值合并入库：通过 Port 进行流式合并 */
async function mergeProfileStream(
  existingText: string,
  newLines: string[],
  onDelta: (delta: string, accumulated: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    let port: chrome.runtime.Port | null = null;
    let finished = false;

    try {
      port = chrome.runtime.connect({ name: 'AI_MERGE_STREAM' });
    } catch (err) {
      reject(err);
      return;
    }

    port.onDisconnect.addListener(() => {
      if (!finished) {
        const err = chrome.runtime.lastError?.message || '与后台脚本连接断开';
        reject(new Error(err));
      }
    });

    port.onMessage.addListener(
      (msg: { type: string; delta?: string; accumulated?: string; data?: unknown; error?: string }) => {
        if (msg.type === 'delta') {
          if (typeof msg.accumulated === 'string') {
            onDelta(msg.delta ?? '', msg.accumulated);
          }
        } else if (msg.type === 'done') {
          finished = true;
          try {
            port?.disconnect();
          } catch {
            /* 端口断开忽略 */
          }
          const raw = typeof msg.data === 'string' ? unwrapJsonWrappedText(msg.data) : msg.data;
          const checked = validateCandidateProfile(raw);
          if (checked.ok && checked.text) {
            resolve(checked.text);
          } else {
            reject(new Error(checked.errors.join('；') || 'AI 合并输出格式不正确'));
          }
        } else if (msg.type === 'error') {
          finished = true;
          try {
            port?.disconnect();
          } catch {
            /* 端口断开忽略 */
          }
          reject(new Error(msg.error || 'AI 合并失败'));
        }
      }
    );

    port.postMessage({
      type: 'AI_MERGE',
      existingText,
      newLines,
    });
  });
}

/** 简历拖拽入库：AI 解析→文本校验，失败带上校验错误让 AI 改一次（非流式兜底） */
async function parseResumeWithRetry(text: string) {
  let fixHint: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await sendToBackground<ParseMessage>({
      type: 'AI_PARSE',
      text: text.slice(0, MAX_RESUME_TEXT_LENGTH),
      fixHint,
    });
    if (!response) throw new Error('后台脚本未响应');
    if (!response.ok || response.data === undefined) {
      throw new Error(response.error || 'AI 解析失败');
    }
    // 兜底：AI_MERGE/AI_PARSE 在 json_object 协议下可能返回 {type,content} JSON 串，先解包再校验。
    const raw = typeof response.data === 'string' ? unwrapJsonWrappedText(response.data) : response.data;
    const checked = validateCandidateProfile(raw);
    if (checked.ok && checked.text) return checked.text;
    fixHint = checked.errors.slice(0, 5).join('；') || '输出内容太短，请输出完整的分类整理文本';
  }
  throw new Error('AI 输出内容太短，已让 AI 改过一次仍失败：' + fixHint);
}

/** “输出太短”类错误判据（ai.ts 分级阈值/校验文案都含“太短”）：仅这类错误走原文拼接兜底。 */
function isShortOutputError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes('太短');
}

/**
 * 候选人信息库：storage 状态 + 多文件暂存 + 解析/追加合并/删除。
 *
 * 与旧版的关键区别：拖入文件只进暂存列表，不立刻解析；点“解析并保存”后
 * 一次性把 N 个文件拼成一段（上限 MAX_RESUME_TEXT_LENGTH）发给 AI，
 * 已有信息库时走 AI_MERGE 追加合并，绝不直接覆盖。
 */
export function useCandidate() {
  const [candidate, setCandidate] = React.useState<CandidateStatus>({
    state: 'loading',
    text: null,
    updatedAt: null,
    error: null,
  });
  const [candidateBusy, setCandidateBusy] = React.useState(false);
  const [streamState, setStreamState] = React.useState<CandidateStreamState>({
    streaming: false,
    text: '',
    error: null,
  });
  const [merging, setMerging] = React.useState(false);
  const mergingRef = React.useRef(false);
  const [dragActive, setDragActive] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  // 暂存文件：state 给渲染，ref 给异步流程（setState 更新是异步的，流程里读 ref 才不丢新增文件）
  const [staged, setStaged] = React.useState<StagedFileItem[]>([]);
  const stagedRef = React.useRef<StagedFileItem[]>([]);
  const filesRef = React.useRef<Map<string, File>>(new Map());
  const textCacheRef = React.useRef<Map<string, string>>(new Map());
  const [progress, setProgress] = React.useState<CandidateProgress>(IDLE_PROGRESS);
  const [preview, setPreview] = React.useState<FilePreview | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const deletingRef = React.useRef(false);
  const busyRef = React.useRef(false);

  const commitStaged = React.useCallback((next: StagedFileItem[]) => {
    stagedRef.current = next;
    setStaged(next);
  }, []);

  const patchStaged = React.useCallback(
    (id: string, patch: Partial<StagedFileItem>) => {
      commitStaged(stagedRef.current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    },
    [commitStaged]
  );

  const refresh = React.useCallback(async () => {
    try {
      setCandidate(await loadCandidateStatus());
    } catch (error) {
      setCandidate({ state: 'invalid', text: null, updatedAt: null, error: errorText(error) });
    }
  }, []);

  /** 读文件文本并缓存（同一文件预览/解析只读一次，docx 解析很贵） */
  async function readIntoCache(id: string): Promise<string> {
    const cached = textCacheRef.current.get(id);
    if (cached !== undefined) return cached;
    const file = filesRef.current.get(id);
    if (!file) throw new Error('文件已从列表移除，请重新拖入');
    const text = await readResumeFile(file);
    textCacheRef.current.set(id, text);
    return text;
  }

  /** 追加文件到暂存列表：过滤不支持的后缀 / 超大文件 / 重复文件，超过上限就停 */
  const addFiles = React.useCallback(
    (incoming: FileList | File[] | null) => {
      if (!incoming) return;
      if (busyRef.current) {
        toast.info('正在处理当前文件，稍等再添加');
        return;
      }
      const files = Array.from(incoming);
      if (!files.length) return;
      let list = [...stagedRef.current];
      const rejected: string[] = [];
      const oversize: string[] = [];
      const duplicated: string[] = [];
      let overflow = false;
      for (const file of files) {
        const ext = fileExt(file.name);
        if (!SUPPORTED_EXTS.has(ext)) {
          rejected.push(file.name);
          continue;
        }
        if (file.size > MAX_RESUME_FILE_BYTES) {
          oversize.push(file.name);
          continue;
        }
        if (list.some((item) => item.name === file.name && item.size === file.size)) {
          duplicated.push(file.name);
          continue;
        }
        if (list.length >= MAX_STAGED_FILES) {
          overflow = true;
          break;
        }
        const item: StagedFileItem = {
          id: newId(),
          name: file.name,
          size: file.size,
          ext,
          status: 'staged',
        };
        filesRef.current.set(item.id, file);
        list = [...list, item];
      }
      commitStaged(list);
      if (rejected.length) {
        toast.error(`跳过 ${rejected.length} 个不支持的文件`, { description: '只支持 .txt / .md / .docx' });
      }
      if (oversize.length) {
        toast.error(`跳过 ${oversize.length} 个超过 ${formatFileSize(MAX_RESUME_FILE_BYTES)} 的文件`);
      }
      if (duplicated.length) toast.info(`已跳过 ${duplicated.length} 个已在列表里的重复文件`);
      if (overflow) toast.info(`一次最多暂存 ${MAX_STAGED_FILES} 个文件`);
    },
    [commitStaged]
  );

  const removeStagedFile = React.useCallback(
    (id: string) => {
      if (busyRef.current) return;
      filesRef.current.delete(id);
      textCacheRef.current.delete(id);
      commitStaged(stagedRef.current.filter((item) => item.id !== id));
      setPreview((prev) => (prev && prev.id === id ? null : prev));
    },
    [commitStaged]
  );

  const clearStaged = React.useCallback(() => {
    if (busyRef.current) return;
    filesRef.current.clear();
    textCacheRef.current.clear();
    commitStaged([]);
    setPreview(null);
  }, [commitStaged]);

  /** 预览某个文件：读正文放进弹窗，顺便把暂存项标为已读取 */
  const openPreview = React.useCallback(
    async (id: string) => {
      const file = filesRef.current.get(id);
      if (!file) return;
      const item = stagedRef.current.find((entry) => entry.id === id);
      setPreview({
        id,
        name: file.name,
        sizeText: formatFileSize(file.size),
        charCount: item?.charCount,
        text: '',
        loading: true,
        error: null,
      });
      try {
        const text = await readIntoCache(id);
        if (item && item.status !== 'ready') {
          patchStaged(id, { status: 'ready', charCount: charCountOf(text), error: undefined });
        }
        setPreview((prev) =>
          prev && prev.id === id ? { ...prev, text, charCount: charCountOf(text), loading: false } : prev
        );
      } catch (error) {
        const msg = errorText(error);
        patchStaged(id, { status: 'error', error: msg });
        setPreview((prev) => (prev && prev.id === id ? { ...prev, loading: false, error: msg } : prev));
      }
    },
    [patchStaged]
  );

  const closePreview = React.useCallback(() => setPreview(null), []);

  /** 删除整个信息库（正文 + 更新时间），暂存文件不受影响 */
  const deleteProfile = React.useCallback(async (): Promise<boolean> => {
    if (deletingRef.current || busyRef.current) return false;
    deletingRef.current = true;
    setDeleting(true);
    try {
      await clearCandidateText();
      setCandidate({ state: 'empty', text: null, updatedAt: null, error: null });
      toast.success('信息库已删除');
      return true;
    } catch (error) {
      toast.error('删除失败', { description: errorText(error) });
      return false;
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  }, []);

  /**
   * 解析暂存文件并入库：
   * 读取（0-15%）→ 合并成一段发 AI 解析（15-70%）→ 已有信息库时追加合并（70-92%）→ 写入（94-100%）。
   * 已有信息库时绝不覆盖：AI 合并失败（非“太短”类）直接报错，暂存文件保留可重试。
   */
  const runStagedParse = React.useCallback(async () => {
    if (busyRef.current || mergingRef.current) return;
    const targets = stagedRef.current.filter((item) => item.status !== 'error');
    if (!targets.length) {
      toast.info('没有可解析的文件，先拖入 .txt / .md / .docx');
      return;
    }
    busyRef.current = true;
    setCandidateBusy(true);
    setProgress({ active: true, percent: 2, label: '读取文件…', detail: `0/${targets.length}` });
    setStreamState({ streaming: false, text: '', error: null, title: '正在读取文件…' });
    const parsedIds: string[] = [];
    try {
      // 1) 逐个读成文本，拼成一段（超过上限就截断，避免送不进 AI）
      const parts: string[] = [];
      let totalLength = 0;
      let truncated = false;
      for (let index = 0; index < targets.length; index += 1) {
        const item = targets[index]!;
        patchStaged(item.id, { status: 'reading', error: undefined });
        setProgress({
          active: true,
          percent: Math.max(2, Math.round(((index + 0.4) / targets.length) * 15)),
          label: '读取文件…',
          detail: `${index + 1}/${targets.length} · ${item.name}`,
        });
        let text = '';
        try {
          text = await readIntoCache(item.id);
        } catch (error) {
          patchStaged(item.id, { status: 'error', error: errorText(error) });
          continue;
        }
        parsedIds.push(item.id);
        patchStaged(item.id, { status: 'ready', charCount: charCountOf(text), error: undefined });
        const block = `【文件：${item.name}】\n${text}`;
        if (totalLength + block.length > MAX_RESUME_TEXT_LENGTH) {
          const room = MAX_RESUME_TEXT_LENGTH - totalLength;
          if (room > 0) {
            parts.push(block.slice(0, room));
            totalLength += room;
          }
          truncated = true;
          break;
        }
        parts.push(block);
        totalLength += block.length;
      }
      if (!parts.length) throw new Error('没有文件读取成功，检查文件是否为空或格式不支持');
      const combined = parts.join('\n\n');
      const detail = `${parsedIds.length} 个文件 · ${charCountOf(combined).toLocaleString('zh-CN')} 字${
        truncated ? '（已截断到 3 万字）' : ''
      }`;

      // 2) N 个文件一起发给 AI 解析
      setProgress({ active: true, percent: 15, label: 'AI 正在解析…', detail });
      setStreamState({ streaming: true, text: '', error: null, title: 'AI 正在解析…' });
      let parsed = '';
      try {
        parsed = await parseResumeStream(combined, (_delta, accumulated) => {
          setStreamState({ streaming: true, text: accumulated, error: null, title: 'AI 正在解析…' });
          setProgress((prev) =>
            prev.active
              ? {
                  ...prev,
                  percent: Math.max(prev.percent, Math.min(70, 15 + 55 * Math.min(1, accumulated.length / 1200))),
                }
              : prev
          );
        });
      } catch (streamError) {
        try {
          parsed = await parseResumeWithRetry(combined);
        } catch {
          throw streamError;
        }
      }

      // 3) 已有信息库 → 追加合并；没有 → 直接写入
      const status = await loadCandidateStatus();
      const existingText = status.state === 'ready' && status.text ? status.text : '';
      let finalText = parsed;
      if (existingText) {
        setProgress({ active: true, percent: 70, label: '追加合并进信息库…', detail });
        setStreamState({ streaming: true, text: '', error: null, title: '正在合并信息库…' });
        const lines = parsed
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        try {
          finalText = await mergeProfileStream(existingText, lines, (_delta, accumulated) => {
            setStreamState({ streaming: true, text: accumulated, error: null, title: '正在合并信息库…' });
            setProgress((prev) =>
              prev.active
                ? {
                    ...prev,
                    percent: Math.max(prev.percent, Math.min(92, 70 + 22 * Math.min(1, accumulated.length / 1200))),
                  }
                : prev
            );
          });
        } catch (error) {
          // 只有“输出太短”类失败才降级成原文拼接；其它错误原样抛，避免把半成品写进信息库
          if (!isShortOutputError(error)) throw error;
          const fallback = existingText.trim() + '\n' + parsed.trim();
          const rechecked = validateCandidateProfile(fallback);
          if (!rechecked.ok || !rechecked.text) throw error;
          finalText = rechecked.text;
        }
      }

      // 合并结果防呆：追加语义下结果不应比原库少一半，出现就中止，避免 AI 缩写把资料写没
      const beforeChars = charCountOf(existingText);
      const afterChars = charCountOf(finalText);
      if (existingText && afterChars < beforeChars * 0.5) {
        throw new Error(`合并结果只有 ${afterChars} 字（原信息库 ${beforeChars} 字），疑似丢内容，已中止未写入`);
      }

      // 4) 写入并清理已成功解析的暂存文件
      setProgress({ active: true, percent: 94, label: '写入信息库…', detail });
      const updatedAt = await saveCandidateText(finalText);
      setCandidate({ state: 'ready', text: finalText, updatedAt, error: null });
      commitStaged(stagedRef.current.filter((item) => !parsedIds.includes(item.id)));
      for (const id of parsedIds) {
        filesRef.current.delete(id);
        textCacheRef.current.delete(id);
      }
      setStreamState({
        streaming: false,
        text: finalText,
        error: null,
        title: existingText ? '已追加合并' : '已写入信息库',
      });
      setProgress({ active: true, percent: 100, label: existingText ? '已追加合并' : '已写入信息库', detail });
      window.setTimeout(() => {
        setProgress((prev) => (prev.active && prev.percent >= 100 ? IDLE_PROGRESS : prev));
      }, 900);
      toast.success(existingText ? '已追加合并进信息库' : '信息库已保存', {
        description: `共 ${charCountOf(finalText).toLocaleString('zh-CN')} 字 · ${parsedIds.length} 个文件`,
      });
      if (truncated) {
        toast.info('超出 3 万字的文件未纳入本次解析', { description: '可移除已解析的文件后再点一次，分批解析。' });
      }
    } catch (error) {
      const msg = errorText(error);
      setStreamState({ streaming: false, text: '', error: msg, title: '解析失败' });
      setProgress(IDLE_PROGRESS);
      toast.error('文件解析失败', { description: msg });
    } finally {
      busyRef.current = false;
      setCandidateBusy(false);
    }
  }, [commitStaged, patchStaged]);

  /** 弹窗编辑保存：写 storage 后直接刷新本地状态（含更新时间），调用方只管 toast/关窗。注意必须在 mergeManualLines 之前声明（后者依赖数组立即求值，写在后面会 TDZ 白屏）。 */
  const saveEditedProfile = React.useCallback(async (text: string) => {
    const updatedAt = await saveCandidateText(text);
    setCandidate({ state: 'ready', text, updatedAt, error: null });
    return updatedAt;
  }, []);

  /** 手动补值合并入库：AI_MERGE→文本校验（非空+分级长度）→复用保存链路；失败抛错由调用方 toast。防重入：合并中再次调用直接返回 null。空行/输入材料不足 20 字直接跳过（返回 null，不调 AI、不抛错）。AI 输出过短时降级为原文拼接（去重+长度校验），材料足够仍可入库；材料本身不足时抛原错。 */
  const mergeManualLines = React.useCallback(
    async (newLines: string[]) => {
      const lines = newLines.map((line) => String(line ?? '').trim()).filter(Boolean);
      if (!lines.length) return null;
      if (mergingRef.current) return null;
      mergingRef.current = true;
      setMerging(true);
      setStreamState({ streaming: true, text: '', error: null, title: '正在合并信息库…' });
      try {
        const status = await loadCandidateStatus();
        const existingText = status.state === 'ready' && status.text ? status.text : '';
        // 材料本身不足 20 字时（如首次导入只有一两个短字段）：如实输出必然过不了长度门，
        // 直接跳过合并（不调 AI、不报错），页面已填值不受影响；等以后材料攒够再合。
        const inputLength = (existingText + '\n' + lines.join('\n')).replace(/\s+/g, '').length;
        if (inputLength < MIN_CANDIDATE_TEXT_LENGTH) {
          setStreamState({ streaming: false, text: '', error: null });
          return null;
        }
        let mergedText = '';
        try {
          try {
            mergedText = await mergeProfileStream(existingText, lines, (_delta, acc) => {
              setStreamState({ streaming: true, text: acc, error: null, title: '正在合并信息库…' });
            });
          } catch (streamError) {
            // 流式异常时降级尝试常规 sendToBackground
            const response = await sendToBackground<MergeMessage>({ type: 'AI_MERGE', existingText, newLines: lines });
            if (!response) throw streamError;
            if (!response.ok || response.data === undefined) throw new Error(response.error || '信息库合并失败');
            const rawData = typeof response.data === 'string' ? unwrapJsonWrappedText(response.data) : response.data;
            const checked = validateCandidateProfile(rawData);
            if (!checked.ok || !checked.text) {
              throw new Error(checked.errors.join('；') || 'AI 合并结果太短，未存入信息库');
            }
            mergedText = checked.text;
          }

          setStreamState({ streaming: false, text: mergedText, error: null, title: '已合并' });
          await saveEditedProfile(mergedText);
          return mergedText;
        } catch (error) {
          setStreamState((prev) => ({ ...prev, streaming: false, error: errorText(error) }));
          // 降级兜底：仅对“太短”类失败做原文拼接（新增行去重后追加），校验通过则直接入库；
          // 材料本身不足 20 字时拼接也过不了校验，此时抛原错（行为与之前一致）。
          if (!isShortOutputError(error)) throw error;
          const missing = lines.filter((line) => !existingText.includes(line));
          if (!missing.length) return null;
          const fallback = (existingText ? existingText + '\n' : '') + missing.join('\n');
          const rechecked = validateCandidateProfile(fallback);
          if (!rechecked.ok || !rechecked.text) throw error;
          await saveEditedProfile(rechecked.text);
          return rechecked.text;
        }
      } finally {
        mergingRef.current = false;
        setMerging(false);
      }
    },
    [saveEditedProfile]
  );

  return {
    candidate,
    candidateBusy,
    streamState,
    merging,
    mergeManualLines,
    dragActive,
    setDragActive,
    fileInputRef,
    refresh,
    saveEditedProfile,
    // 多文件暂存 / 解析进度 / 删除 / 预览
    staged,
    progress,
    addFiles,
    removeStagedFile,
    clearStaged,
    runStagedParse,
    deleteProfile,
    deleting,
    preview,
    openPreview,
    closePreview,
  };
}

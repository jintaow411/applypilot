/**
 * 候选人信息库 · 文件暂存 / 解析进度共享类型。
 * 单独成文件，避免展示组件反向 import hook（hooks.ts 会 import 这些类型）。
 */

/** 单个暂存文件的状态：staged 已入列未读 / reading 读取中 / ready 已读成文本 / error 读取失败 */
export type StagedFileStatus = 'staged' | 'reading' | 'ready' | 'error';

/** 暂存列表里的一项（只放展示需要的字段，原始 File 留在 hook 的 ref 里） */
export interface StagedFileItem {
  id: string;
  name: string;
  /** 字节数 */
  size: number;
  /** 小写扩展名，不含点，例如 'docx'、'txt' */
  ext: string;
  status: StagedFileStatus;
  /** 读取成功后的有效字数（去空白） */
  charCount?: number;
  error?: string;
}

/** 解析/合并进度：percent 0-100，label 是当前阶段文案，detail 是补充说明（文件数/字数） */
export interface CandidateProgress {
  active: boolean;
  percent: number;
  label: string;
  detail?: string;
}

/** 文件预览弹窗的数据 */
export interface FilePreview {
  id: string;
  name: string;
  sizeText: string;
  charCount?: number;
  text: string;
  loading: boolean;
  error: string | null;
}

/**
 * 候选人信息库 · 待解析文件列表 + 解析进度。
 * 纯展示组件：状态与回调都由 feature hook 提供，这里只负责渲染。
 * 约束：侧边栏宽度 320-480px，所有文本一律 truncate，绝不出现横向滚动。
 */

import * as React from 'react';
import { AlertCircle, Check, File, FileText, FileType2, Loader2, X, type LucideIcon } from 'lucide-react';
import { Button } from '../../../../components/ui/button';
import { cn } from '../../../../components/ui/utils';
import type { CandidateProgress, StagedFileItem } from './types';

export interface StagedFilesProps {
  files: StagedFileItem[];
  progress: CandidateProgress;
  /** 解析/合并进行中：禁用删除、清空、打开 */
  disabled?: boolean;
  /** 点击某个文件（预览内容） */
  onOpen: (id: string) => void;
  /** 移除某个文件 */
  onRemove: (id: string) => void;
  /** 清空所有暂存文件 */
  onClear: () => void;
}

/** 字节数转可读大小：B / KB / MB，保留 1 位小数 */
function formatSize(bytes: number): string {
  const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (size < 1024) return Math.round(size) + ' B';
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
  return (size / (1024 * 1024)).toFixed(1) + ' MB';
}

/** 千分位：12345 → 12,345 */
function formatNumber(value: number): string {
  const count = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** percent 夹到 0-100；NaN / Infinity 一律当 0 */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** 扩展名 → 图标：文本类 FileText，Word 类 FileType2，其余 File */
function iconOf(ext: string): LucideIcon {
  if (ext === 'txt' || ext === 'md' || ext === 'markdown') return FileText;
  if (ext === 'docx' || ext === 'doc') return FileType2;
  return File;
}

/** 单行状态文案：克制为主，只给 ready / error 上色 */
function StatusLine(props: { file: StagedFileItem }) {
  const file = props.file;
  if (file.status === 'reading') {
    return (
      <span className="flex min-w-0 items-center gap-1 text-foreground-subtle">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
        <span className="truncate">读取中</span>
      </span>
    );
  }
  if (file.status === 'ready') {
    return (
      <span className="flex min-w-0 items-center gap-1 text-success">
        <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="truncate">已读取 {formatNumber(file.charCount ?? 0)} 字</span>
      </span>
    );
  }
  if (file.status === 'error') {
    const reason = file.error || '读取失败';
    return (
      <span className="flex min-w-0 items-center gap-1 text-destructive">
        <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate" title={reason}>{reason}</span>
      </span>
    );
  }
  return <span className="min-w-0 truncate text-foreground-subtlest">待解析</span>;
}

/** 进度条：label / detail / percent 一行，下面是 6px 高轨道 */
function ProgressBar(props: { progress: CandidateProgress }) {
  const label = props.progress.label;
  const detail = props.progress.detail;
  const percent = clampPercent(props.progress.percent);
  const shown = Math.round(percent);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn('min-w-0 truncate text-ui-xs text-foreground-subtle', detail ? 'shrink' : 'flex-1')} title={label}>{label}</span>
        {detail ? (
          <span className="min-w-0 flex-1 truncate text-ui-2xs text-foreground-subtlest" title={detail}>{detail}</span>
        ) : null}
        <span className="shrink-0 text-ui-xs font-medium tabular-nums text-foreground">{shown}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={shown}
        aria-label={label || '解析进度'}
        className="h-1.5 overflow-hidden rounded-full bg-surface"
      >
        <div
          className="h-full rounded-full bg-brand transition-[width] duration-200 ease-out"
          style={{ width: percent + '%' }}
        />
      </div>
    </div>
  );
}

/** 文件行：扩展名块 / 文件名 + meta / 移除按钮 */
function StagedFileRow(props: {
  file: StagedFileItem;
  disabled: boolean;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const file = props.file;
  const disabled = props.disabled;
  // error 行不提供预览（没有可预览的内容），解析中整体禁用
  const clickable = !disabled && file.status !== 'error';
  const Icon = iconOf(file.ext);
  const removeLabel = '移除 ' + file.name;

  // 只在行自身获得焦点时响应：避免在移除按钮上按 Enter 连带触发预览
  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    props.onOpen(file.id);
  }

  return (
    <li className="border-b border-border/70 last:border-b-0">
      <div
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-label={clickable ? '预览 ' + file.name : undefined}
        onClick={clickable ? function () { props.onOpen(file.id); } : undefined}
        onKeyDown={clickable ? handleKeyDown : undefined}
        className={cn(
          'group flex min-h-10 min-w-0 items-center gap-2 px-2.5 py-2 transition-colors',
          clickable
            ? 'cursor-pointer hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand'
            : 'cursor-default'
        )}
      >
        {/* 扩展名块：图标只是文件类型的提示，不承担导航 */}
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand">
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </span>

        {/* 文件名 + meta：两层信息，长名一律 truncate */}
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui-sm font-medium text-foreground" title={file.name}>{file.name}</div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-ui-2xs leading-tight tabular-nums text-foreground-subtlest">
            <span className="shrink-0">{formatSize(file.size)}</span>
            {file.ext ? (
              <span className="shrink-0 rounded bg-surface px-1 uppercase text-foreground-subtle">{file.ext}</span>
            ) : null}
            <StatusLine file={file} />
          </div>
        </div>

        {/* 移除：hover / 键盘 focus 才出现，解析中直接不渲染 */}
        {disabled ? null : (
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
            title={removeLabel}
            aria-label={removeLabel}
            onClick={function (event) { event.stopPropagation(); props.onRemove(file.id); }}
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </Button>
        )}
      </div>
    </li>
  );
}

export function StagedFiles(props: StagedFilesProps): React.ReactElement | null {
  const files = props.files;
  const progress = props.progress;
  const disabled = props.disabled === true;
  const active = progress.active === true;

  // 没文件也不在解析：完全让位，不占高度
  if (files.length === 0 && !active) return null;

  // 合计字数只统计已读成功的文件
  const totalChars = files.reduce(function (sum, file) {
    if (file.status !== 'ready') return sum;
    return sum + (file.charCount ?? 0);
  }, 0);

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      {files.length > 0 ? (
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 truncate text-ui-xs text-foreground-subtle">
            待解析 · {files.length} 个文件{totalChars > 0 ? ' · 合计 ' + formatNumber(totalChars) + ' 字' : ''}
          </span>
          <Button
            variant="ghost"
            size="xs"
            className="-mr-1 shrink-0"
            disabled={disabled}
            onClick={props.onClear}
          >
            清空
          </Button>
        </div>
      ) : null}

      {active ? <ProgressBar progress={progress} /> : null}

      {files.length > 0 ? (
        <ul className="max-h-52 min-w-0 overflow-y-auto overflow-x-hidden rounded-lg border border-border bg-card">
          {files.map(function (file) {
            return (
              <StagedFileRow
                key={file.id}
                file={file}
                disabled={disabled}
                onOpen={props.onOpen}
                onRemove={props.onRemove}
              />
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

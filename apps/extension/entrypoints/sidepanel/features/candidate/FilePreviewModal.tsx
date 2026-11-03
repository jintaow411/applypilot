import * as React from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Modal } from '../../components/Modal';

export interface FilePreviewModalProps {
  name: string;
  sizeText: string;
  charCount?: number;
  text: string;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
}

/**
 * 文件预览弹窗：只读展示解析出来的纯文本，不提供编辑。
 * 复用 Modal 基座（wide）：Esc / 点遮罩 / 关闭按钮都能关。
 */
export function FilePreviewModal(props: FilePreviewModalProps): React.ReactElement {
  const { name, sizeText, charCount, text, loading, error, onClose } = props;
  const busy = Boolean(loading);
  const hasError = Boolean(error);

  return (
    <Modal title="文件预览" onClose={onClose} wide>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground" title={name}>
            {name}
          </span>
          <span className="shrink-0 whitespace-nowrap text-ui-2xs tabular-nums text-foreground-subtlest">
            {sizeText}{typeof charCount === 'number' ? ' · ' + charCount.toLocaleString('en-US') + ' 字' : null}
          </span>
        </div>

        <div className="max-h-[46vh] min-h-24 min-w-0 overflow-auto rounded-md border border-border bg-surface px-2.5 py-2">
          {busy ? (
            <div className="flex min-h-20 items-center justify-center gap-2 text-ui-sm text-foreground-subtle">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
              <span>正在读取文件…</span>
            </div>
          ) : hasError ? (
            <div className="flex items-start gap-2 text-ui-sm text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 break-words">{error}</span>
            </div>
          ) : text ? (
            <div className="min-w-0 whitespace-pre-wrap break-words font-mono text-ui-xs leading-relaxed text-foreground">
              {text}
            </div>
          ) : (
            <div className="text-ui-sm text-foreground-subtlest">没有可预览的文本内容。</div>
          )}
        </div>
      </div>
    </Modal>
  );
}

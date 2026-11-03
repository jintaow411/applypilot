import * as React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button } from '../../../components/ui/button';

/**
 * 弹窗：portal 到 document.body，不透明面板 + 分区 header/body/footer。
 * Esc / 点遮罩 / 关闭按钮均可关；打开时锁定 body 滚动，关闭恢复。
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** 宽版：表单类弹窗用，默认窄版行为不变 */
  wide?: boolean;
}) {
  const titleId = React.useId();
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    const previousOverflow = document.body.style.overflow;
    document.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-overlay backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={wide ? "relative flex max-h-[85vh] w-[calc(100%-2rem)] max-w-[560px] flex-col overflow-hidden rounded-xl border border-popover-border bg-popover text-foreground shadow-2xl" : "relative flex max-h-[85vh] w-[calc(100%-2rem)] max-w-[420px] flex-col overflow-hidden rounded-xl border border-popover-border bg-popover text-foreground shadow-2xl"}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h3 id={titleId} className="min-w-0 truncate text-ui-lg font-semibold text-foreground">
            {title}
          </h3>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
          >
            <X />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer ? (
          <div className="sticky bottom-0 flex shrink-0 items-center gap-2 border-t border-border bg-popover px-4 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  );
}

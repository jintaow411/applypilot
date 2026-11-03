import * as React from 'react';
import { X } from 'lucide-react';

import { cn } from './utils';

interface DialogContextValue { open: boolean; setOpen: (open: boolean) => void }
const DialogContext = React.createContext<DialogContextValue>({ open: false, setOpen: () => {} });

export function Dialog({ open, defaultOpen, onOpenChange, children }: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
}) {
  const [inner, setInner] = React.useState(defaultOpen ?? false);
  const value = open ?? inner;
  const setOpen = (v: boolean) => {
    if (open === undefined) setInner(v);
    onOpenChange?.(v);
  };
  return <DialogContext.Provider value={{ open: value, setOpen }}>{children}</DialogContext.Provider>;
}

export function DialogTrigger({ className, onClick, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { setOpen } = React.useContext(DialogContext);
  return (
    <button type="button" data-slot="dialog-trigger" className={className}
      onClick={(e) => { onClick?.(e); setOpen(true); }} {...props}>
      {children}
    </button>
  );
}

export function DialogPortal({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

export function DialogOverlay({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const { open } = React.useContext(DialogContext);
  if (!open) return null;
  return <div data-slot="dialog-overlay" className={cn('fixed inset-0 z-50 bg-background/80', className)} {...props} />;
}

export function DialogContent({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const { open, setOpen } = React.useContext(DialogContext);
  if (!open) return null;
  return (
    <DialogPortal>
      <DialogOverlay />
      <div role="dialog" aria-modal="true" data-slot="dialog-content"
        className={cn('fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100%-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-auto rounded-2xl border border-popover-border bg-popover p-4 text-ui-base text-foreground shadow-md outline-none', className)}
        {...props}>
        {children}
        <button type="button" aria-label="关闭" data-slot="dialog-close" onClick={() => setOpen(false)}
          className="absolute right-4 top-4 inline-flex size-6 items-center justify-center rounded-md text-foreground-subtle transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3.5">
          <X />
        </button>
      </div>
    </DialogPortal>
  );
}

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="dialog-header" className={cn('flex flex-col gap-1', className)} {...props} />;
}

export function DialogTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 data-slot="dialog-title" className={cn('text-ui-base font-medium leading-none', className)} {...props} />;
}

export function DialogDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p data-slot="dialog-description" className={cn('text-ui-sm text-foreground-subtle', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="dialog-footer" className={cn('flex items-center justify-end gap-2', className)} {...props} />;
}

export function DialogClose({ className, onClick, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { setOpen } = React.useContext(DialogContext);
  return (
    <button type="button" data-slot="dialog-close" className={className}
      onClick={(e) => { onClick?.(e); setOpen(false); }} {...props}>
      {children}
    </button>
  );
}

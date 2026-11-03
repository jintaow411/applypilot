import * as React from 'react';
import { cn } from './utils';
const TooltipDelayContext = React.createContext(200);
export function TooltipProvider({ children, delayDuration = 200 }: {
  children?: React.ReactNode;
  delayDuration?: number;
}) {
  return <TooltipDelayContext.Provider value={delayDuration}>{children}</TooltipDelayContext.Provider>;
}
export function Tooltip({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span data-slot="tooltip" className={cn('group/tooltip relative inline-flex', className)} {...props} />;
}
export function TooltipTrigger({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span data-slot="tooltip-trigger" className={cn('inline-flex', className)} {...props} />;
}
const sidePosition: Record<'top' | 'bottom' | 'left' | 'right', string> = {
  top: 'bottom-full left-1/2 mb-2 -translate-x-1/2',
  bottom: 'left-1/2 top-full mt-2 -translate-x-1/2',
  left: 'right-full top-1/2 mr-2 -translate-y-1/2',
  right: 'left-full top-1/2 ml-2 -translate-y-1/2',
};
export function TooltipContent({ className, side = 'top', style, ...props }: React.HTMLAttributes<HTMLSpanElement> & {
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  const delay = React.useContext(TooltipDelayContext);
  return (
    <span
      role="tooltip"
      data-slot="tooltip-content"
      data-side={side}
      style={{ transitionDelay: delay + 'ms', ...style }}
      className={cn(
        'pointer-events-none absolute z-50 w-max max-w-60 rounded-lg border border-popover-border bg-tooltip px-3 py-1.5 text-ui-sm text-tooltip-foreground opacity-0 shadow-md transition-opacity duration-150 group-hover/tooltip:opacity-100',
        sidePosition[side],
        className
      )}
      {...props}
    />
  );
}

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './utils';

const buttonVariants = cva(
  [
    'inline-flex select-none items-center justify-center whitespace-nowrap rounded-md text-ui-base font-medium transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background',
    'disabled:pointer-events-none disabled:opacity-60',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-3.5',
  ].join(' '),
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        outline: 'border border-input-border bg-input text-foreground hover:border-input-border-hover hover:bg-surface-hover',
        secondary: 'bg-muted text-foreground hover:bg-surface-hover',
        ghost: 'text-foreground-subtle hover:bg-surface-hover hover:text-foreground',
        destructive: 'bg-destructive text-destructive-foreground hover:opacity-90',
        warning: 'bg-warning text-warning-foreground hover:opacity-90',
        link: 'text-brand underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-8 gap-1 px-2',
        xs: 'h-6 gap-1 rounded-sm px-1.5 text-ui-xs [&_svg]:size-3',
        sm: 'h-7 gap-1 px-2 text-ui-sm',
        lg: 'h-9 gap-1.5 rounded-lg px-3 [&_svg]:size-4',
        icon: 'size-8 [&_svg]:size-4',
        'icon-xs': 'size-6 rounded-sm [&_svg]:size-3',
        'icon-sm': 'size-7 [&_svg]:size-3.5',
        'icon-md': 'size-8 rounded-lg [&_svg]:size-4',
        'icon-lg': 'size-9 rounded-lg [&_svg]:size-4',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, type = 'button', children, ...props }, ref) => {
    const cls = cn(buttonVariants({ variant, size }), className);
    const data = {
      'data-slot': 'button',
      'data-variant': variant ?? 'default',
      'data-size': size ?? 'default',
    } as const;
    if (asChild && React.isValidElement(children)) {
      const child = children as React.ReactElement<Record<string, unknown>>;
      return React.cloneElement(child, { ...data, className: cn(child.props.className as string, cls) });
    }
    return (
      <button ref={ref} type={type} className={cls} {...data} {...props}>
        {children}
      </button>
    );
  }
);
Button.displayName = 'Button';

export { buttonVariants };

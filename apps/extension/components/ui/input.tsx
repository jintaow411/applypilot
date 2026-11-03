import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './utils';

const inputVariants = cva(
  [
    'w-full border border-input-border bg-input px-2 text-ui-base text-foreground outline-none transition-colors',
    'placeholder:text-foreground-subtlest',
    'hover:border-input-border-hover',
    'focus:bg-surface-hover',
    'disabled:cursor-not-allowed disabled:opacity-60',
    'aria-[invalid=true]:border-destructive',
  ].join(' '),
  {
    variants: {
      size: {
        xs: 'h-6 rounded-sm text-ui-xs',
        sm: 'h-7 rounded-md',
        default: 'h-8 rounded-md',
        lg: 'h-9 rounded-lg',
      },
    },
    defaultVariants: { size: 'default' },
  }
);

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'>,
    VariantProps<typeof inputVariants> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, size, type = 'text', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      data-slot="input"
      data-size={size ?? 'default'}
      className={cn(inputVariants({ size }), className)}
      {...props}
    />
  )
);
Input.displayName = 'Input';

export { inputVariants };

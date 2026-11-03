import * as React from 'react';

export function SettingField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-ui-sm font-medium text-foreground">{label}</span>
        {hint ? (
          <span className="min-w-0 truncate text-ui-xs text-foreground-subtle" title={hint}>
            {hint}
          </span>
        ) : null}
      </span>
      {children}
    </label>
  );
}

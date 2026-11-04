import * as S from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export interface SelectOption<V extends string = string> {
  value: V;
  label: ReactNode;
  /** Plain text label (for the trigger when label is rich). */
  text?: string;
  icon?: ReactNode;
}

/** Radix uses '' as "no value", so we map a sentinel for "all"/"none". */
const NONE = '__none__';

export function Select<V extends string>({
  value,
  onValueChange,
  options,
  placeholder = 'Select…',
  ariaLabel,
  id,
  className,
  allowNone,
  noneLabel = 'Any',
  size = 'md',
  disabled,
}: {
  value: V | null | undefined;
  onValueChange: (v: V | null) => void;
  options: SelectOption<V>[];
  placeholder?: string;
  ariaLabel?: string;
  id?: string;
  className?: string;
  allowNone?: boolean;
  noneLabel?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <S.Root
      value={value ?? (allowNone ? NONE : undefined)}
      onValueChange={(v) => onValueChange(v === NONE ? null : (v as V))}
      disabled={disabled}
    >
      <S.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          'inline-flex min-w-0 items-center justify-between gap-2 rounded-md border border-border-strong/70 bg-surface px-2.5 text-[13px] text-fg shadow-sm',
          'outline-none hover:bg-surface-2 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring/40 data-[placeholder]:text-fg-3',
          size === 'sm' ? 'h-7 text-xs' : 'h-8',
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          {current?.icon}
          <S.Value placeholder={placeholder}>
            {current ? (current.text ?? current.label) : allowNone && value == null ? noneLabel : undefined}
          </S.Value>
        </span>
        <S.Icon>
          <ChevronDown className="size-3.5 text-fg-3" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-md"
        >
          <S.Viewport>
            {allowNone ? <Item value={NONE}>{noneLabel}</Item> : null}
            {options.map((o) => (
              <Item key={o.value} value={o.value} icon={o.icon}>
                {o.label}
              </Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}

function Item({ value, children, icon }: { value: string; children: ReactNode; icon?: ReactNode }) {
  return (
    <S.Item
      value={value}
      className="relative flex cursor-default items-center gap-2 rounded-md py-1.5 pr-7 pl-2 text-[13px] text-fg outline-none select-none data-[highlighted]:bg-surface-2"
    >
      {icon}
      <S.ItemText>{children}</S.ItemText>
      <S.ItemIndicator className="absolute right-2">
        <Check className="size-3.5 text-accent" />
      </S.ItemIndicator>
    </S.Item>
  );
}

/** Native select for dense contexts (tables, mapping grids) — robust and accessible. */
export function NativeSelect({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cn('relative inline-flex', className)}>
      <select
        className="h-8 w-full appearance-none rounded-md border border-border-strong/70 bg-surface pr-7 pl-2.5 text-[13px] text-fg shadow-sm outline-none hover:bg-surface-2 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring/40"
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
    </div>
  );
}

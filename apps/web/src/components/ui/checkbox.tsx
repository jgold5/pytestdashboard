import * as C from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';
import { cn } from '../../lib/utils';

export function Checkbox({
  checked,
  onCheckedChange,
  ariaLabel,
  className,
  id,
}: {
  checked: boolean | 'indeterminate';
  onCheckedChange: (c: boolean) => void;
  ariaLabel?: string;
  className?: string;
  id?: string;
}) {
  return (
    <C.Root
      id={id}
      checked={checked}
      onCheckedChange={(c) => onCheckedChange(c === true)}
      aria-label={ariaLabel}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-[4px] border border-border-strong bg-surface shadow-sm outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=checked]:border-accent data-[state=checked]:bg-accent',
        'data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent',
        className,
      )}
    >
      <C.Indicator className="text-accent-fg">
        {checked === 'indeterminate' ? <Minus className="size-3" strokeWidth={3} /> : <Check className="size-3" strokeWidth={3} />}
      </C.Indicator>
    </C.Root>
  );
}

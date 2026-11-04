import { Check } from 'lucide-react';
import { cn } from '../lib/utils';

export function Brand({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <span className="grid size-6 place-items-center rounded-md bg-accent text-accent-fg shadow-sm">
        <Check className="size-3.5" strokeWidth={3} aria-hidden />
      </span>
      {compact ? null : <span className="text-[13px] font-semibold tracking-tight text-fg">Test Automation</span>}
    </span>
  );
}

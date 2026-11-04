import { cn } from '../../lib/utils';

/** Button styles for <Link>/<a> elements. */
export function linkButton(variant: 'primary' | 'secondary' | 'outline' | 'ghost' = 'secondary', size: 'sm' | 'md' = 'md', className?: string) {
  return cn(
    'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap font-medium outline-none transition-[background,filter] focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-4',
    size === 'sm' ? 'h-7 rounded-md px-2.5 text-xs gap-1.5' : 'h-8 rounded-md px-3 text-[13px]',
    variant === 'primary' && 'bg-accent text-accent-fg shadow-sm hover:brightness-110',
    variant === 'secondary' && 'border border-border bg-surface-2 text-fg hover:bg-surface-3',
    variant === 'outline' && 'border border-border-strong/70 bg-surface text-fg shadow-sm hover:bg-surface-2',
    variant === 'ghost' && 'text-fg-2 hover:bg-surface-2 hover:text-fg',
    className,
  );
}

import { cn } from '../../lib/utils';

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('skeleton rounded-md', className)} />;
}

export function SkeletonRows({ rows = 8, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2 p-4', className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-7 w-full" />
      ))}
    </div>
  );
}

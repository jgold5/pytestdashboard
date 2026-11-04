import * as T from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export const TooltipProvider = T.Provider;

export function Tooltip({
  content,
  children,
  side = 'top',
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}) {
  if (content === null || content === undefined || content === '') return <>{children}</>;
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            'z-50 max-w-xs rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-fg shadow-md',
            className,
          )}
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

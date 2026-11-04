import * as D from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export const DialogRoot = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px] data-[state=open]:animate-in" />
        <D.Content
          className={cn(
            'fixed top-[8vh] left-1/2 z-50 flex max-h-[84vh] w-[calc(100vw-24px)] max-w-lg -translate-x-1/2 flex-col',
            'rounded-xl border border-border bg-surface shadow-lg outline-none',
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-3.5">
            <div className="min-w-0">
              <D.Title className="text-sm font-semibold text-fg">{title}</D.Title>
              {description ? (
                <D.Description className="mt-0.5 text-xs text-fg-2">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">Dialog</D.Description>
              )}
            </div>
            <D.Close
              className="-mr-1 grid size-7 place-items-center rounded-md text-fg-3 hover:bg-surface-2 hover:text-fg"
              aria-label="Close"
            >
              <X className="size-4" />
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-2/50 px-5 py-3 rounded-b-xl">
              {footer}
            </div>
          ) : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

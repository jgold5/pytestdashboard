import * as M from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;
export const MenuSub = M.Sub;

export function MenuContent({ className, align = 'end', ...props }: M.DropdownMenuContentProps) {
  return (
    <M.Portal>
      <M.Content
        align={align}
        sideOffset={4}
        collisionPadding={8}
        className={cn('z-50 min-w-44 rounded-lg border border-border bg-surface p-1 shadow-md', className)}
        {...props}
      />
    </M.Portal>
  );
}

const itemCls =
  'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-fg outline-none select-none data-[highlighted]:bg-surface-2 data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-fg-3';

export function MenuItem({ className, ...props }: M.DropdownMenuItemProps) {
  return <M.Item className={cn(itemCls, className)} {...props} />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <M.Label className="px-2 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-fg-3 uppercase">{children}</M.Label>;
}

export function MenuSeparator() {
  return <M.Separator className="my-1 h-px bg-border" />;
}

export function MenuSubTrigger({ className, ...props }: M.DropdownMenuSubTriggerProps) {
  return <M.SubTrigger className={cn(itemCls, 'data-[state=open]:bg-surface-2', className)} {...props} />;
}

export function MenuSubContent({ className, ...props }: M.DropdownMenuSubContentProps) {
  return (
    <M.Portal>
      <M.SubContent
        sideOffset={4}
        collisionPadding={8}
        className={cn('z-50 min-w-44 rounded-lg border border-border bg-surface p-1 shadow-md', className)}
        {...props}
      />
    </M.Portal>
  );
}

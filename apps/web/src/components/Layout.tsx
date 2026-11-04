import { useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import * as D from '@radix-ui/react-dialog';
import {
  CirclePlay,
  GitPullRequest,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu as MenuIcon,
  Plug,
  Search,
  Upload,
  X,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useLogout, useSession } from '../api/hooks';
import { Brand } from './Brand';
import { ModeSwitch } from './ModeSwitch';
import { ThemeToggle } from './ThemeToggle';
import { Button } from './ui/button';
import { Kbd } from './ui/misc';
import { CommandPalette, useCommandPaletteHotkey } from './CommandPalette';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/tests', label: 'Test cases', icon: ListChecks },
  { to: '/pulls', label: 'Pull requests', icon: GitPullRequest },
  { to: '/runs', label: 'Runs', icon: CirclePlay },
  { to: '/import', label: 'Import', icon: Upload },
  { to: '/integrations', label: 'Integrations', icon: Plug },
];

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <ul className="space-y-0.5">
      {NAV.map((n) => (
        <li key={n.to}>
          <NavLink
            to={n.to}
            end={n.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                isActive ? 'bg-surface-3/70 text-fg' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
              )
            }
          >
            {({ isActive }) => (
              <>
                <n.icon className={cn('size-4', isActive ? 'text-accent' : 'text-fg-3')} aria-hidden />
                {n.label}
              </>
            )}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

function SignOut({ className }: { className?: string }) {
  const session = useSession();
  const logout = useLogout();
  if (!session.data?.authRequired) return null;
  return (
    <Button variant="ghost" size="sm" className={cn('justify-start', className)} onClick={() => logout.mutate()} loading={logout.isPending}>
      <LogOut /> Sign out
    </Button>
  );
}

export function WorkspaceLayout() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  useCommandPaletteHotkey(() => setPaletteOpen(true));
  const location = useLocation();

  return (
    <div className="min-h-dvh bg-bg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-md"
      >
        Skip to content
      </a>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-56 flex-col border-r border-border bg-surface/60 backdrop-blur lg:flex">
        <div className="flex h-12 items-center px-4">
          <Link to="/" className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <Brand />
          </Link>
        </div>
        <div className="px-3 pt-1 pb-3">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex h-8 w-full items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg-3 shadow-sm outline-none hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Search className="size-3.5" aria-hidden />
            <span className="flex-1 text-left">Search cases…</span>
            <Kbd>⌘K</Kbd>
          </button>
        </div>
        <nav aria-label="Main" className="flex-1 overflow-y-auto px-3">
          <NavItems />
        </nav>
        <div className="border-t border-border p-3">
          <SignOut className="w-full" />
        </div>
      </aside>

      {/* Top bar */}
      <header className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-border bg-bg/85 px-3 backdrop-blur sm:px-4 lg:ml-56">
        <D.Root open={mobileOpen} onOpenChange={setMobileOpen}>
          <D.Trigger asChild>
            <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation">
              <MenuIcon />
            </Button>
          </D.Trigger>
          <D.Portal>
            <D.Overlay className="fixed inset-0 z-40 bg-black/40 lg:hidden" />
            <D.Content className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-border bg-surface shadow-lg outline-none lg:hidden">
              <D.Title className="sr-only">Navigation</D.Title>
              <D.Description className="sr-only">Main navigation</D.Description>
              <div className="flex h-12 items-center justify-between px-4">
                <Brand />
                <D.Close asChild>
                  <Button variant="ghost" size="icon" aria-label="Close navigation">
                    <X />
                  </Button>
                </D.Close>
              </div>
              <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-2">
                <NavItems onNavigate={() => setMobileOpen(false)} />
              </nav>
              <div className="border-t border-border p-3">
                <SignOut className="w-full" />
              </div>
            </D.Content>
          </D.Portal>
        </D.Root>
        <Link to="/" className="lg:hidden" aria-label="Home">
          <Brand compact />
        </Link>
        <ModeSwitch className="ml-1 lg:ml-0" />
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Search test cases" onClick={() => setPaletteOpen(true)}>
            <Search />
          </Button>
          <ThemeToggle />
        </div>
      </header>

      <main id="main" className="lg:ml-56" key={location.pathname.split('/')[1]}>
        <div className="mx-auto w-full max-w-[1440px] px-4 py-5 sm:px-6 sm:py-6">
          <Outlet />
        </div>
      </main>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

/** Minimal chrome for the presentation report (both editors and viewers). */
export function ReportLayout({ children }: { children?: ReactNode }) {
  const session = useSession();
  const isViewer = session.data?.role === 'viewer';
  return (
    <div className="min-h-dvh bg-bg">
      <header className="no-print sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-border bg-bg/85 px-3 backdrop-blur sm:px-5">
        <Brand compact={!isViewer} className={isViewer ? '' : 'sm:hidden'} />
        {!isViewer ? (
          <>
            <Brand className="hidden sm:inline-flex" />
            <ModeSwitch className="ml-2" />
          </>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          {isViewer ? <SignOut /> : null}
        </div>
      </header>
      <main id="main">{children ?? <Outlet />}</main>
    </div>
  );
}

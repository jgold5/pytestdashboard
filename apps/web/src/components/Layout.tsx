import { useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import * as D from '@radix-ui/react-dialog';
import {
  Bug,
  CirclePlay,
  GitPullRequest,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu as MenuIcon,
  Plug,
  Presentation,
  Search,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useLogout, useSession } from '../api/hooks';
import { Brand } from './Brand';
import { ModeSwitch } from './ModeSwitch';
import { ThemeToggle } from './ThemeToggle';
import { Button } from './ui/button';
import { Kbd } from './ui/misc';
import { Tooltip } from './ui/tooltip';
import { CommandPalette, useCommandPaletteHotkey } from './CommandPalette';

/** Day-to-day pages: tabs in the top bar. */
const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/tests', label: 'Test cases', icon: ListChecks },
  { to: '/triggers', label: 'Triggers', icon: Zap },
  { to: '/runs', label: 'Runs', icon: CirclePlay },
  { to: '/bugs', label: 'Bugs', icon: Bug },
  { to: '/pulls', label: 'Pull requests', icon: GitPullRequest },
];
/** Setup pages: icon buttons on the right of the top bar. */
const SETUP = [
  { to: '/import', label: 'Import', icon: Upload },
  { to: '/integrations', label: 'Integrations', icon: Plug },
];

function DrawerNav({ onNavigate }: { onNavigate: () => void }) {
  const item = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex h-9 items-center gap-2.5 rounded-md px-2.5 text-[14px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
      isActive ? 'bg-surface-3/70 text-fg' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
    );
  const list = (items: typeof NAV) => (
    <ul className="space-y-0.5">
      {items.map((n) => (
        <li key={n.to}>
          <NavLink to={n.to} end={'end' in n ? n.end : undefined} onClick={onNavigate} className={item}>
            <n.icon className="size-4 text-fg-3" aria-hidden />
            {n.label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
  return (
    <>
      {list(NAV)}
      <div className="mt-4 mb-1 px-2.5 text-[11px] font-semibold tracking-[0.08em] text-fg-3 uppercase">Setup</div>
      {list(SETUP)}
      <div className="mt-4 mb-1 px-2.5 text-[11px] font-semibold tracking-[0.08em] text-fg-3 uppercase">Share</div>
      <ul>
        <li>
          <NavLink to="/report" onClick={onNavigate} className={item}>
            <Presentation className="size-4 text-fg-3" aria-hidden />
            Report
          </NavLink>
        </li>
      </ul>
    </>
  );
}

function SignOut({ className, iconOnly }: { className?: string; iconOnly?: boolean }) {
  const session = useSession();
  const logout = useLogout();
  if (!session.data?.authRequired) return null;
  if (iconOnly) {
    return (
      <Tooltip content="Sign out" side="bottom">
        <Button variant="ghost" size="icon" className={className} aria-label="Sign out" onClick={() => logout.mutate()} loading={logout.isPending}>
          <LogOut />
        </Button>
      </Tooltip>
    );
  }
  return (
    <Button variant="ghost" size="sm" className={cn('justify-start', className)} onClick={() => logout.mutate()} loading={logout.isPending}>
      <LogOut /> Sign out
    </Button>
  );
}

/** Icon-only nav link with a tooltip. Works out its own active state: Radix's asChild would
 * stringify NavLink's className function. */
function IconNavLink({ to, label, tip, icon: Icon }: { to: string; label: string; tip?: string; icon: typeof Upload }) {
  const { pathname } = useLocation();
  const active = pathname === to || pathname.startsWith(`${to}/`);
  return (
    <Tooltip content={tip ?? label} side="bottom">
      <Link
        to={to}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'inline-flex size-8 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-4',
          active ? 'bg-surface-3 text-fg' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
        )}
      >
        <Icon aria-hidden />
      </Link>
    </Tooltip>
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

      <header className="sticky top-0 z-20 border-b border-border bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-13 w-full max-w-[1440px] items-center gap-2 px-3 sm:px-6 lg:gap-6">
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
                <div className="flex h-13 items-center justify-between px-4">
                  <Brand />
                  <D.Close asChild>
                    <Button variant="ghost" size="icon" aria-label="Close navigation">
                      <X />
                    </Button>
                  </D.Close>
                </div>
                <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-2">
                  <DrawerNav onNavigate={() => setMobileOpen(false)} />
                </nav>
                <div className="border-t border-border p-3">
                  <SignOut className="w-full" />
                </div>
              </D.Content>
            </D.Portal>
          </D.Root>

          <Link to="/" className="shrink-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50" aria-label="Overview">
            <Brand className="max-sm:[&>span:last-child]:hidden" />
          </Link>

          <nav aria-label="Main" className="hidden h-full min-w-0 items-stretch overflow-x-auto lg:flex">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  cn(
                    '-mb-px flex shrink-0 items-center border-b-2 px-3 text-[13.5px] font-medium whitespace-nowrap outline-none transition-colors focus-visible:bg-surface-2',
                    isActive ? 'border-accent text-fg' : 'border-transparent text-fg-2 hover:text-fg',
                  )
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="hidden h-8 w-60 items-center gap-2 rounded-md border border-border bg-bg px-2.5 text-[13px] text-fg-3 outline-none hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-ring/50 xl:flex"
            >
              <Search className="size-3.5" aria-hidden />
              <span className="flex-1 text-left">Search cases…</span>
              <Kbd>⌘K</Kbd>
            </button>
            <Button variant="ghost" size="icon" className="xl:hidden" aria-label="Search test cases" onClick={() => setPaletteOpen(true)}>
              <Search />
            </Button>
            <div className="hidden items-center gap-1 lg:flex">
              {SETUP.map((n) => (
                <IconNavLink key={n.to} to={n.to} label={n.label} icon={n.icon} />
              ))}
              <IconNavLink to="/report" label="Report" tip="Report: the read-only page for stakeholders" icon={Presentation} />
            </div>
            <ThemeToggle />
            <SignOut iconOnly className="hidden lg:inline-flex" />
          </div>
        </div>
      </header>

      <main id="main" key={location.pathname.split('/')[1]}>
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

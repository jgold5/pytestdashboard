import * as P from '@radix-ui/react-popover';
import { Check, ChevronDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { TRIGGER_KIND_LABEL, type TriggerKind } from '@ptd/shared';
import { useTriggerOverview } from '../api/hooks';
import { cn, fmtNumber, pluralize } from '../lib/utils';
import { UnlinkedTestsDialog } from './UnlinkedTests';

/**
 * What a page counts: a branch of the trigger repo (routes), the test repo branch whose merged
 * tests count with the PRs into it (tests), optionally one folder, and optionally some kinds of
 * trigger (comma-separated). null = the default: the default routes branch, the tests branch
 * named like the routes branch (else the test repo's default), all folders, every kind.
 */
export interface Scope {
  branch: string | null;
  folder: string | null;
  tests: string | null;
  kinds: string | null;
}

/** Short names for the button's label. */
const KIND_SHORT: Record<TriggerKind, string> = {
  file: 'load file',
  schedule: 'schedule',
  direct: 'direct',
  queue: 'queue',
  kafka: 'kafka',
  rest: 'REST',
  property: 'property-only',
};

/** "all types", "load file + schedule", "4 types" */
export function kindsLabel(kinds: string | null): string {
  const list = (kinds ?? '').split(',').filter(Boolean) as TriggerKind[];
  if (list.length === 0) return 'all types';
  return list.length <= 2 ? list.map((k) => KIND_SHORT[k] ?? k).join(' + ') : `${list.length} types`;
}

/**
 * The routes and tests branches a scope stands for, worked out like the server does (a picked
 * branch it has, else the default; tests: the picked branch, else the one named like the routes
 * branch, else the test repo's default), so a pick shows before the new counts arrive.
 */
export function scopeSelection(
  scope: Pick<Scope, 'branch' | 'tests'>,
  d: { routeBranches: string[]; defaultBranch: string | null; testBranches: string[]; triggerRepo?: { branch: string } | null; testRepo?: { branch: string } | null },
): { routes: string; tests: string | null; autoTests: string | null } {
  const routes =
    scope.branch && d.routeBranches.includes(scope.branch) ? scope.branch : (d.defaultBranch ?? d.triggerRepo?.branch ?? d.routeBranches[0]!);
  // the tests branch used when none is picked: the one named like the routes branch, else the default
  const autoTests = d.testBranches.includes(routes) ? routes : (d.testBranches[0] ?? null);
  const tests =
    scope.tests && d.testBranches.includes(scope.tests)
      ? scope.tests
      : scope.tests
        ? (d.testRepo?.branch ?? autoTests) // a branch the list doesn't show (from a link): the server's answer
        : (autoTests ?? d.testRepo?.branch ?? null);
  return { routes, tests, autoTests };
}

/** One button that reads like a sentence ("core · tests main · common/ · all types"); the lists open in a panel. */
export function ScopeButton({
  scope,
  onChange,
  className,
}: {
  scope: Scope;
  onChange: (patch: Partial<Scope>) => void;
  className?: string;
}) {
  const q = useTriggerOverview(undefined, 1, scope.branch, scope.folder, scope.tests, scope.kinds);
  const [showUnlinked, setShowUnlinked] = useState(false);
  const d = q.data;
  if (!d || d.routeBranches.length === 0) return null;

  // what was picked shows at once; the counts follow when the server answers
  const { routes, tests, autoTests } = scopeSelection(scope, d);
  const updating = q.isPlaceholderData;
  const folders = d.folders;
  const folderMissing = scope.folder && !folders.some((f) => f.folder === scope.folder);
  const prs = d.unmergedFrom.filter((b) => !d.looseTestBranches.includes(b));
  const picked = (scope.kinds ?? '').split(',').filter(Boolean);
  const kindCounts = d.kindCounts;
  // toggling a kind: none picked = every kind, so the first click keeps only that one
  const toggleKind = (k: TriggerKind) => {
    const all = kindCounts.map((c) => c.kind);
    const next = picked.length === 0 ? [k] : picked.includes(k) ? picked.filter((x) => x !== k) : [...picked, k];
    const ordered = all.filter((x) => next.includes(x)).concat(next.filter((x) => !all.includes(x as TriggerKind)) as TriggerKind[]);
    onChange({ kinds: ordered.length === 0 || all.every((x) => ordered.includes(x)) ? null : ordered.join(',') });
  };
  const label = `${routes} · tests ${tests ?? '—'} · ${scope.folder ? `${scope.folder}/` : 'all folders'} · ${kindsLabel(scope.kinds)}`;

  return (
    <>
      {showUnlinked ? (
        <UnlinkedTestsDialog
          branch={scope.branch}
          tests={scope.tests}
          onClose={() => setShowUnlinked(false)}
        />
      ) : null}
      <P.Root>
        <P.Trigger asChild>
          <button
            type="button"
            aria-label={`Scope: routes from ${routes}, tests from ${tests ?? 'none'}, ${scope.folder ? `folder ${scope.folder}` : 'all folders'}, ${kindsLabel(scope.kinds)}. Change`}
            className={cn(
              'inline-flex h-8 max-w-full min-w-0 items-center gap-2 rounded-md border border-border-strong/70 bg-surface px-3 text-[13px] font-medium text-fg shadow-sm outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-surface-2',
              className,
            )}
          >
            <span className="truncate font-mono text-[12.5px]">{label}</span>
            <ChevronDown className="size-3.5 shrink-0 text-fg-3" aria-hidden />
          </button>
        </P.Trigger>
        <P.Portal>
          <P.Content
            align="end"
            sideOffset={6}
            collisionPadding={12}
            className="z-50 w-[min(820px,calc(100vw-24px))] rounded-lg border border-border bg-surface p-3 shadow-lg outline-none"
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Column title="Routes" hint="trigger repo branch">
                {d.routeBranches.map((b) => (
                  <Choice
                    key={b}
                    selected={b === routes}
                    onSelect={() => onChange({ branch: b === d.defaultBranch ? null : b })}
                  >
                    {b}
                    {b === d.defaultBranch ? (
                      <span className="ml-2 font-sans text-[11px] text-fg-3">default</span>
                    ) : null}
                  </Choice>
                ))}
              </Column>
              <Column title="Tests" hint="merged tests + PRs into it">
                {d.testBranches.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-fg-3">No test repo scanned yet.</p>
                ) : null}
                {d.testBranches.map((b) => (
                  <Choice
                    key={b}
                    selected={b === tests}
                    onSelect={() => onChange({ tests: b === autoTests ? null : b })}
                  >
                    {b}
                  </Choice>
                ))}
              </Column>
              <Column title="Folder" hint={`on ${routes}`}>
                <Choice selected={!scope.folder} onSelect={() => onChange({ folder: null })}>
                  All folders
                </Choice>
                {folderMissing ? (
                  <Choice selected onSelect={() => onChange({ folder: null })}>
                    {scope.folder}/ <span className="ml-1 text-warn">not on {routes}</span>
                  </Choice>
                ) : null}
                {folders.map((f) => (
                  <Choice
                    key={f.folder}
                    selected={f.folder === scope.folder}
                    onSelect={() => onChange({ folder: f.folder })}
                  >
                    <span className="truncate">{f.folder}/</span>
                    <span className={cn('ml-auto shrink-0 pl-2 text-fg-3 tabular', updating && 'opacity-50')}>
                      {fmtNumber(f.tested)}/{fmtNumber(f.triggers)}
                    </span>
                  </Choice>
                ))}
              </Column>
              <Column title="Types" hint="tested/total" multi>
                <Choice selected={picked.length === 0} onSelect={() => onChange({ kinds: null })}>
                  All types
                </Choice>
                {kindCounts.map((c) => (
                  <Choice key={c.kind} multi selected={picked.includes(c.kind)} onSelect={() => toggleKind(c.kind)}>
                    <span className="truncate font-sans">{TRIGGER_KIND_LABEL[c.kind]}</span>
                    <span className={cn('ml-auto shrink-0 pl-2 text-fg-3 tabular', updating && 'opacity-50')}>
                      {fmtNumber(c.tested)}/{fmtNumber(c.triggers)}
                    </span>
                  </Choice>
                ))}
                {picked.length > 0 && picked.length < kindCounts.length ? (
                  <p className="px-2 pt-1 text-[11px] text-fg-3">Counts, folders and lists show only the ticked types.</p>
                ) : null}
              </Column>
            </div>
            <div className={cn('mt-3 space-y-0.5 border-t border-border pt-2.5 text-xs text-fg-2', updating && 'opacity-60')} aria-busy={updating}>
              {updating ? <p className="text-fg-3">Updating counts…</p> : null}
              {tests ? (
                prs.length > 0 ? (
                  <p>
                    {pluralize(prs.length, 'open PR', 'open PRs')} into{' '}
                    <span className="font-mono">{tests}</span> {prs.length === 1 ? 'is' : 'are'}{' '}
                    counted as not merged yet.
                  </p>
                ) : (
                  <p className="text-warn">
                    No open PRs into {tests} scanned yet: use Scan open PRs on Triggers.
                  </p>
                )
              ) : null}
              {d.testRepo ? (
                <p className="text-fg-3">
                  {pluralize(d.testRepo.tests, 'test')} on {d.testRepo.branch},{' '}
                  {fmtNumber(d.testRepo.testsLinked)} of them hit a trigger.
                  {d.testRepo.tests > d.testRepo.testsLinked ? (
                    <>
                      {' '}
                      <button type="button" className="link" onClick={() => setShowUnlinked(true)}>
                        See the {fmtNumber(d.testRepo.tests - d.testRepo.testsLinked)} that don't
                      </button>
                    </>
                  ) : null}
                </p>
              ) : null}
              {d.looseTestBranches.length > 0 ? (
                <p className="text-fg-3">
                  {d.looseTestBranches.length === 1
                    ? 'A branch'
                    : `${d.looseTestBranches.length} branches`}{' '}
                  scanned by hand (
                  <span className="font-mono">{d.looseTestBranches.slice(0, 3).join(', ')}</span>
                  {d.looseTestBranches.length > 3 ? '…' : ''}){' '}
                  {d.looseTestBranches.length === 1 ? "isn't" : "aren't"} linked to a PR, so{' '}
                  {d.looseTestBranches.length === 1 ? "it doesn't" : "they don't"} count: which branch{' '}
                  {d.looseTestBranches.length === 1 ? 'it merges' : 'they merge'} into is unknown. Scan open PRs
                  links them.
                </p>
              ) : null}
              {d.outdated.routes || d.outdated.tests || d.outdated.prs > 0 ? (
                <p className="text-warn">
                  The counting rules changed since{' '}
                  {[
                    d.outdated.routes ? `the routes scan of ${d.outdated.routes}` : null,
                    d.outdated.tests ? `the tests scan of ${d.outdated.tests}` : null,
                    d.outdated.prs > 0 ? pluralize(d.outdated.prs, 'PR scan') : null,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                  : rescan {d.outdated.prs > 0 && !d.outdated.routes && !d.outdated.tests ? 'with Scan open PRs' : 'them (Scan a branch, then Scan open PRs)'} for exact numbers.
                </p>
              ) : null}
            </div>
          </P.Content>
        </P.Portal>
      </P.Root>
    </>
  );
}

function Column({ title, hint, multi, children }: { title: string; hint: string; multi?: boolean; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 px-2">
        <span className="text-[11px] font-semibold tracking-[0.07em] text-fg-3 uppercase">
          {title}
        </span>
        <span className="ml-1.5 text-[11px] text-fg-3">{hint}</span>
      </div>
      <div role={multi ? 'group' : 'radiogroup'} aria-label={title} className="max-h-60 space-y-px overflow-y-auto">
        {children}
      </div>
    </div>
  );
}

function Choice({
  selected,
  onSelect,
  multi,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  /** A tick box (several can be picked) rather than a radio. */
  multi?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role={multi ? 'checkbox' : 'radio'}
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        selected ? 'bg-surface-3 text-fg' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
      )}
    >
      {multi ? (
        <span
          className={cn('grid size-3 shrink-0 place-items-center rounded-[3px] border', selected ? 'border-accent bg-accent text-surface' : 'border-border-strong')}
          aria-hidden
        >
          {selected ? <Check className="size-2.5" strokeWidth={3} /> : null}
        </span>
      ) : (
        <span
          className={cn('size-1.5 shrink-0 rounded-full', selected ? 'bg-accent' : 'bg-transparent')}
          aria-hidden
        />
      )}
      <span className="flex min-w-0 flex-1 items-center">{children}</span>
    </button>
  );
}

import * as P from '@radix-ui/react-popover';
import { ChevronDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTriggerOverview } from '../api/hooks';
import { cn, fmtNumber, pluralize } from '../lib/utils';
import { UnlinkedTestsDialog } from './UnlinkedTests';

/**
 * What a page counts: a branch of the trigger repo (routes), the test repo branch whose merged
 * tests count with the PRs into it (tests), and optionally one folder. null = the default:
 * the default routes branch, the tests branch named like the routes branch (else the test
 * repo's default), all folders.
 */
export interface Scope {
  branch: string | null;
  folder: string | null;
  tests: string | null;
}

/** One button that reads like a sentence ("core · tests main · common/"); the lists open in a panel. */
export function ScopeButton({
  scope,
  onChange,
  className,
}: {
  scope: Scope;
  onChange: (patch: Partial<Scope>) => void;
  className?: string;
}) {
  const q = useTriggerOverview(undefined, 1, scope.branch, scope.folder, scope.tests);
  const [showUnlinked, setShowUnlinked] = useState(false);
  const d = q.data;
  if (!d || d.routeBranches.length === 0) return null;

  const routes = d.triggerRepo?.branch ?? d.defaultBranch ?? d.routeBranches[0]!;
  const tests = d.testRepo?.branch ?? null;
  // the tests branch used when none is picked: the one named like the routes branch, else the default
  const autoTests = d.testBranches.includes(routes) ? routes : (d.testBranches[0] ?? null);
  const folders = d.folders;
  const folderMissing = scope.folder && !folders.some((f) => f.folder === scope.folder);
  const prs = d.unmergedFrom.filter((b) => !d.looseTestBranches.includes(b));
  const label = `${routes} · tests ${tests ?? '—'} · ${scope.folder ? `${scope.folder}/` : 'all folders'}`;

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
            aria-label={`Scope: routes from ${routes}, tests from ${tests ?? 'none'}, ${scope.folder ? `folder ${scope.folder}` : 'all folders'}. Change`}
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
            className="z-50 w-[min(620px,calc(100vw-24px))] rounded-lg border border-border bg-surface p-3 shadow-lg outline-none"
          >
            <div className="grid gap-3 sm:grid-cols-3">
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
                    <span className="ml-auto shrink-0 pl-2 text-fg-3 tabular">
                      {fmtNumber(f.tested)}/{fmtNumber(f.triggers)}
                    </span>
                  </Choice>
                ))}
              </Column>
            </div>
            <div className="mt-3 space-y-0.5 border-t border-border pt-2.5 text-xs text-fg-2">
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
                  {d.looseTestBranches.length === 1 ? 'it counts' : 'they count'} for the default
                  branch only. Scan open PRs links them.
                </p>
              ) : null}
            </div>
          </P.Content>
        </P.Portal>
      </P.Root>
    </>
  );
}

function Column({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 px-2">
        <span className="text-[11px] font-semibold tracking-[0.07em] text-fg-3 uppercase">
          {title}
        </span>
        <span className="ml-1.5 text-[11px] text-fg-3">{hint}</span>
      </div>
      <div role="radiogroup" aria-label={title} className="max-h-60 space-y-px overflow-y-auto">
        {children}
      </div>
    </div>
  );
}

function Choice({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        selected ? 'bg-surface-3 text-fg' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
      )}
    >
      <span
        className={cn('size-1.5 shrink-0 rounded-full', selected ? 'bg-accent' : 'bg-transparent')}
        aria-hidden
      />
      <span className="flex min-w-0 flex-1 items-center">{children}</span>
    </button>
  );
}

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { useUnlinkedTests } from '../api/hooks';
import { fmtNumber, pluralize } from '../lib/utils';
import { Dialog } from './ui/dialog';
import { Input } from './ui/input';

/**
 * The tests that hit no trigger, and the strings the scanner read in each: a test only covers
 * a trigger when one of these names it (route id, schedule, file name, trigger file, job).
 */
export function UnlinkedTestsDialog({ branch, tests, onClose }: { branch: string | null; tests: string | null; onClose: () => void }) {
  const q = useUnlinkedTests(branch, tests, true);
  const [search, setSearch] = useState('');
  const d = q.data;
  const byFile = useMemo(() => {
    const s = search.trim().toLowerCase();
    const m = new Map<string, { name: string; strings: string[] }[]>();
    for (const t of d?.tests ?? []) {
      if (s && !t.id.toLowerCase().includes(s) && !t.strings.some((x) => x.toLowerCase().includes(s))) continue;
      const [file, ...rest] = t.id.split('::');
      const list = m.get(file!) ?? [];
      list.push({ name: rest.join('::'), strings: t.strings });
      m.set(file!, list);
    }
    return [...m];
  }, [d, search]);
  const noStrings = (d?.tests ?? []).filter((t) => t.strings.length === 0).length;

  return (
    <Dialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title="Tests that hit no trigger"
      description={
        d ? (
          <>
            {fmtNumber(d.unlinked)} of {pluralize(d.testsRead, 'test')} on <span className="font-mono">{d.testsFrom}</span> name no trigger of{' '}
            <span className="font-mono">{d.routesFrom}</span>. A test covers a trigger when one of the strings below names its route id, schedule, file
            name, trigger file or job.
          </>
        ) : (
          'Loading…'
        )
      }
      className="max-w-3xl"
    >
      {d && d.unlinked > 0 ? (
        <div className="mb-3 space-y-2">
          {noStrings > 0 ? (
            <p className="text-[13px] text-warn">
              {pluralize(noStrings, 'test')} {noStrings === 1 ? 'has' : 'have'} no strings at all: the route name is probably in a helper function, a
              fixture, a constant imported from another file, or a parametrize list, which the scanner doesn't follow yet. Send one as an example.
            </p>
          ) : null}
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
            <Input aria-label="Search tests" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Test, file or string…" className="h-8 pl-7 text-xs" />
          </div>
        </div>
      ) : null}
      {d && d.unlinked === 0 ? <p className="text-[13px] text-fg-2">Every test hits at least one trigger.</p> : null}
      <div className="-mx-1 max-h-[55vh] space-y-3 overflow-auto px-1">
        {byFile.map(([file, list]) => (
          <section key={file}>
            <h3 className="mb-1 truncate font-mono text-[11px] text-fg-3" title={file}>
              {file} · {list.length}
            </h3>
            <ul className="space-y-1.5">
              {list.map((t) => (
                <li key={t.name} className="rounded-md border border-border px-2.5 py-1.5">
                  <div className="truncate font-mono text-xs text-fg">{t.name}</div>
                  {t.strings.length ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {t.strings.map((x) => (
                        <span key={x} className="max-w-[260px] truncate rounded bg-surface-2 px-1.5 font-mono text-[11px] text-fg-2" title={x}>
                          {x}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-0.5 text-[11px] text-warn">no strings read</div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
        {d && d.tests.length < d.unlinked ? <p className="text-xs text-fg-3">Showing the first {fmtNumber(d.tests.length)}.</p> : null}
      </div>
    </Dialog>
  );
}

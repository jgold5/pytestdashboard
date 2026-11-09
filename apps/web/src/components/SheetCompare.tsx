import { useMemo, useRef, useState } from 'react';
import { ArrowLeft, Download, FileSpreadsheet, KeyRound, Search, Share2, Sheet } from 'lucide-react';
import type { SheetCompareColumns, SheetComparePreviewResponse, SheetCompareResponse, SheetCompareRow, TriggerKind } from '@ptd/shared';
import { api, errorMessage, uploadWithProgress } from '../api/client';
import { Anonymizer, anonymizeDeep, foldersOf } from '../lib/anonymize';
import { cn, fmtNumber, pluralize } from '../lib/utils';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { Input } from './ui/input';
import { Select } from './ui/select';

const FIELDS: Array<{ key: keyof SheetCompareColumns; label: string; hint: string }> = [
  { key: 'routeId', label: 'Route id', hint: 'required' },
  { key: 'xml', label: 'XML file', hint: 'tells apart one id in several folders' },
  { key: 'kind', label: 'Kind', hint: 'file, schedule, direct, seda, kafka, rest…' },
  { key: 'triggers', label: 'Triggers', hint: 'how many the route has' },
  { key: 'automated', label: 'Automated', hint: 'yes/no, or how many triggers' },
  { key: 'where', label: 'Where', hint: 'folder, or merged / PR' },
  { key: 'testFiles', label: 'Test files', hint: 'that cover it' },
  { key: 'prs', label: 'PRs', hint: 'numbers or branches' },
];
const FIELD_LABEL: Record<string, string> = { kind: 'kind', triggers: 'triggers', automated: 'automated', where: 'where', testFiles: 'test files', prs: 'PRs' };

const STATUS: Record<SheetCompareRow['status'], { label: string; cls: string }> = {
  match: { label: 'Agrees', cls: 'border-[color-mix(in_oklab,var(--st-passed)_40%,transparent)] text-st-passed' },
  differs: { label: 'Differs', cls: 'border-[color-mix(in_oklab,var(--warn)_45%,transparent)] text-warn' },
  sheetOnly: { label: 'Only in sheet', cls: 'border-[color-mix(in_oklab,var(--st-failed)_40%,transparent)] text-st-failed' },
  dashboardOnly: { label: 'Not in sheet', cls: 'border-[color-mix(in_oklab,var(--st-failed)_40%,transparent)] text-st-failed' },
};
type Filter = 'problems' | SheetCompareRow['status'] | 'all';

export interface SheetScope {
  branch: string | null;
  tests: string | null;
  folder: string | null;
  kinds: string | null;
}

/** "Compare with my sheet": upload a spreadsheet of routes and see where it and the dashboard disagree, and why. */
export function SheetCompareButton({ scope }: { scope: SheetScope }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <FileSpreadsheet /> Compare with my sheet
      </Button>
      {open ? <SheetCompareDialog scope={scope} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function SheetCompareDialog({ scope, onClose }: { scope: SheetScope; onClose: () => void }) {
  const [preview, setPreview] = useState<SheetComparePreviewResponse | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [columns, setColumns] = useState<Partial<SheetCompareColumns>>({});
  const [result, setResult] = useState<SheetCompareResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const p = await uploadWithProgress<SheetComparePreviewResponse>('/api/triggers/compare-sheet/preview', form).promise;
      // the first sheet with a route id column, else the first
      const first = p.sheets.find((s) => s.columns.routeId) ?? p.sheets[0];
      setPreview(p);
      setSheet(first?.name ?? null);
      setColumns(first?.columns ?? {});
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const compare = async () => {
    if (!preview || !sheet || !columns.routeId) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        uploadId: preview.uploadId,
        sheet,
        columns,
        ...(scope.branch ? { branch: scope.branch } : {}),
        ...(scope.tests ? { tests: scope.tests } : {}),
        ...(scope.folder ? { folder: scope.folder } : {}),
        ...(scope.kinds ? { kinds: scope.kinds.split(',') as TriggerKind[] } : {}),
      };
      setResult(await api.post<SheetCompareResponse>('/api/triggers/compare-sheet', body));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const current = preview?.sheets.find((s) => s.name === sheet);
  const headerOptions = (current?.headers ?? []).filter(Boolean).map((h) => ({ value: h, label: h }));

  return (
    <Dialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title="Compare with my sheet"
      description="Upload a spreadsheet listing routes (one per row). Each row is lined up with the route the dashboard counts, every column you have is compared, and a route on one side only says why."
      className="max-w-5xl"
      footer={
        result ? (
          <>
            <Button variant="ghost" onClick={() => setResult(null)}>
              <ArrowLeft /> Columns
            </Button>
            <Button variant="outline" onClick={() => downloadCsv(result, preview?.fileName ?? 'sheet')}>
              <Download /> Download comparison (.csv)
            </Button>
            <ShareButtons result={result} fileName={preview?.fileName ?? 'sheet'} />
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {preview ? (
              <Button variant="primary" onClick={() => void compare()} loading={busy} disabled={busy || !columns.routeId}>
                Compare
              </Button>
            ) : null}
          </>
        )
      }
    >
      {error ? <p className="mb-3 text-[13px] text-bad">{error}</p> : null}
      {result ? (
        <>
          <Result result={result} />
          <p className="mt-2 text-xs text-fg-3">
            <Share2 className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />
            <span className="font-medium text-fg-2">Download for sharing</span> saves this comparison with every route, file, test and branch name replaced by a
            made-up one, in your browser. <span className="font-medium text-fg-2">Save the key</span> keeps the way back to your names: don’t send it.
          </p>
        </>
      ) : preview ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <Sheet className="size-4 text-fg-3" aria-hidden />
            <span className="font-medium">{preview.fileName}</span>
            {preview.sheets.length > 1 ? (
              <Select
                size="sm"
                ariaLabel="Sheet"
                value={sheet}
                onValueChange={(v) => {
                  setSheet(v);
                  setColumns(preview.sheets.find((s) => s.name === v)?.columns ?? {});
                }}
                options={preview.sheets.map((s) => ({ value: s.name, label: `${s.name} (${pluralize(s.rowCount, 'row')})` }))}
                className="w-56"
              />
            ) : (
              <span className="text-fg-3">{pluralize(current?.rowCount ?? 0, 'row')}</span>
            )}
            <Button size="sm" variant="ghost" onClick={() => input.current?.click()}>
              Another file
            </Button>
          </div>
          <p className="text-xs text-fg-2">Which column holds what (picked from the headers; leave a field empty to skip it):</p>
          <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <label key={f.key} className="flex items-center gap-2 text-[13px]">
                <span className="w-24 shrink-0 font-medium">{f.label}</span>
                <Select
                  size="sm"
                  ariaLabel={f.label}
                  value={columns[f.key] ?? null}
                  onValueChange={(v) => setColumns((c) => ({ ...c, [f.key]: v ?? undefined }))}
                  options={headerOptions}
                  allowNone={f.key !== 'routeId'}
                  noneLabel="—"
                  className="w-44"
                />
                <span className="truncate text-[11px] text-fg-3">{f.hint}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-fg-3">
            Compared with what the scope button picks: routes on {scope.branch ?? 'the default branch'}, tests {scope.tests ? `from ${scope.tests}` : 'of the same branch'}
            {scope.folder ? `, ${scope.folder}/ only` : ''}
            {scope.kinds ? `, ${scope.kinds.split(',').join(' + ')} only` : ''}.
          </p>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files[0];
            if (f) void upload(f);
          }}
          className="flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong px-6 py-10 text-center outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <FileSpreadsheet className="size-6 text-fg-3" aria-hidden />
          <span className="text-[13px] font-medium">{busy ? 'Reading…' : 'Choose or drop an .xlsx, .csv or .tsv file'}</span>
          <span className="text-xs text-fg-3">Columns like route_id, xml, entry_kind, triggers, automated, where, test_files, prs are found by name.</span>
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept=".xlsx,.csv,.tsv,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = '';
        }}
      />
    </Dialog>
  );
}

function Result({ result }: { result: SheetCompareResponse }) {
  const c = result.counts;
  const [filter, setFilter] = useState<Filter>(c.differs + c.sheetOnly + c.dashboardOnly > 0 ? 'problems' : 'all');
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return result.rows
      .filter((r) => (filter === 'all' ? true : filter === 'problems' ? r.status !== 'match' : r.status === filter))
      .filter((r) => !s || r.routeId.toLowerCase().includes(s) || (r.dashboard?.module ?? '').toLowerCase().includes(s) || (r.note ?? '').toLowerCase().includes(s));
  }, [result, filter, q]);
  const tiles: Array<{ key: Filter; label: string; n: number; tone?: string }> = [
    { key: 'match', label: 'Agree', n: c.match, tone: 'text-st-passed' },
    { key: 'differs', label: 'Differ', n: c.differs, tone: c.differs ? 'text-warn' : undefined },
    { key: 'sheetOnly', label: 'Only in your sheet', n: c.sheetOnly, tone: c.sheetOnly ? 'text-st-failed' : undefined },
    { key: 'dashboardOnly', label: 'Missing from your sheet', n: c.dashboardOnly, tone: c.dashboardOnly ? 'text-st-failed' : undefined },
  ];
  const fields = Object.entries(result.fieldCounts).filter(([, n]) => n > 0);
  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-2">
        {pluralize(c.sheetRows, 'sheet row')} against {pluralize(c.routes, 'route')} counted on <span className="font-mono">{result.routesFrom ?? '—'}</span> (tests from{' '}
        <span className="font-mono">{result.testsFrom ?? '—'}</span>)
        {result.folder ? (
          <>
            , <span className="font-mono">{result.folder}/</span> only
          </>
        ) : null}
        {result.kinds ? `, ${result.kinds.join(' + ')} only` : ''}.
      </p>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {tiles.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setFilter(filter === t.key ? 'all' : t.key)}
            aria-pressed={filter === t.key}
            className={cn(
              'rounded-lg border px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              filter === t.key ? 'border-accent/50 bg-accent-soft' : 'border-border bg-surface hover:bg-surface-2',
            )}
          >
            <div className="text-[11px] font-medium text-fg-2">{t.label}</div>
            <div className={cn('text-xl font-semibold tabular', t.tone)}>{fmtNumber(t.n)}</div>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Show" className="flex flex-wrap gap-1.5">
          {(['problems', 'all'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={filter === k}
              onClick={() => setFilter(k)}
              className={cn(
                'inline-flex h-7 items-center rounded-full border px-3 text-xs outline-none',
                filter === k ? 'border-accent/50 bg-accent-soft font-medium text-fg' : 'border-border bg-surface text-fg-2 hover:bg-surface-2',
              )}
            >
              {k === 'problems' ? `Everything that doesn't agree (${fmtNumber(c.differs + c.sheetOnly + c.dashboardOnly)})` : `All (${fmtNumber(result.rows.length)})`}
            </button>
          ))}
        </div>
        {fields.length ? (
          <span className="text-xs text-fg-3">Differences: {fields.map(([f, n]) => `${FIELD_LABEL[f] ?? f} ${n}`).join(' · ')}</span>
        ) : null}
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
          <Input aria-label="Search the comparison" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Route, folder, reason…" className="h-7 w-52 pl-7 text-xs" />
        </div>
      </div>
      <div className="-mx-1 max-h-[45vh] overflow-auto rounded-md border border-border">
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-[13px] text-fg-2">{filter === 'problems' ? 'Your sheet and the dashboard agree on every route.' : 'Nothing here.'}</p>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-surface-2 text-left text-[11px] font-semibold tracking-[0.05em] text-fg-3 uppercase">
              <tr>
                <th className="px-3 py-2">Route</th>
                <th className="px-3 py-2">Result</th>
                <th className="px-3 py-2">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 1000).map((r, i) => (
                <tr key={`${r.routeId}-${r.sheetRow ?? 'd'}-${i}`} className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    <div className="font-mono text-xs text-fg">{r.routeId}</div>
                    <div className="text-[11px] text-fg-3">
                      {[r.dashboard?.module ? `${r.dashboard.module}/` : null, r.sheetRow ? `sheet row ${r.sheetRow}` : null].filter(Boolean).join(' · ')}
                    </div>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium', STATUS[r.status].cls)}>{STATUS[r.status].label}</span>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.diffs.length ? (
                      <ul className="space-y-0.5">
                        {r.diffs.map((d) => (
                          <li key={d.field}>
                            <span className="font-medium">{FIELD_LABEL[d.field] ?? d.field}:</span> your sheet <span className="font-mono">{d.sheet || '—'}</span>
                            <span className="text-fg-3"> · dashboard </span>
                            <span className="font-mono">{d.dashboard || '—'}</span>
                          </li>
                        ))}
                      </ul>
                    ) : r.note ? (
                      <span className="text-fg-2">{r.note}</span>
                    ) : r.dashboard ? (
                      <span className="text-fg-3">
                        {r.dashboard.tested}/{r.dashboard.triggers} triggers tested
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {rows.length > 1000 ? <p className="text-xs text-fg-3">First 1,000 shown; the download has all {fmtNumber(rows.length)}.</p> : null}
    </div>
  );
}

function downloadCsv(result: SheetCompareResponse, fileName: string) {
  const esc = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['route_id', 'result', 'sheet_row', 'folder', 'xml', 'kinds', 'triggers', 'tested', 'tested_in_pr_only', 'test_files', 'pr_branches', 'differences', 'why'];
  const lines = [head.join(',')];
  for (const r of result.rows) {
    const d = r.dashboard;
    lines.push(
      [
        r.routeId,
        STATUS[r.status].label,
        r.sheetRow,
        d?.module,
        d ? `${d.sourceFile}:${d.line}` : r.sheet?.xml,
        d?.kinds.join(' '),
        d?.triggers,
        d?.tested,
        d?.testedInPrOnly,
        d?.testFiles.join(' '),
        d?.prBranches.join(' '),
        r.diffs.map((x) => `${FIELD_LABEL[x.field] ?? x.field}: sheet ${x.sheet} / dashboard ${x.dashboard}`).join('; '),
        r.note,
      ]
        .map(esc)
        .join(','),
    );
  }
  const blob = new Blob([`${lines.join('\n')}\n`], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${fileName.replace(/\.[^.]+$/, '')}-vs-dashboard.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Fields whose values are the dashboard's own vocabulary, not names. */
const NOT_NAMES = new Set(['status', 'field', 'kinds', 'kind', 'schemes', 'columns', 'sheetRow', 'line']);

/**
 * "Download for sharing": the comparison with every name renamed (the same everywhere), plus a
 * private key to turn the made-up names back into yours. Done here in the browser.
 */
function ShareButtons({ result, fileName }: { result: SheetCompareResponse; fileName: string }) {
  const [key, setKey] = useState<ReturnType<Anonymizer['key']> | null>(null);
  const base = fileName.replace(/\.[^.]+$/, '');
  const save = (name: string, data: unknown) => {
    const blob = new Blob([`${JSON.stringify(data, null, 1)}\n`], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const share = () => {
    const anon = new Anonymizer();
    const renamed = anonymizeDeep(result, anon, NOT_NAMES, false, foldersOf(result));
    save(`${anon.text(base)}-vs-dashboard-share.json`, {
      about:
        'Compare with my sheet: a spreadsheet of routes against what the dashboard counts. Every name is replaced by a made-up word of the same length, the same everywhere; the dashboard’s own words are kept.',
      ...renamed,
    });
    setKey(anon.key());
  };
  return (
    <>
      <Button variant="outline" onClick={share}>
        <Share2 /> Download for sharing
      </Button>
      {key ? (
        <Button variant="outline" onClick={() => save(`${base}-share-key.json`, { about: 'Made-up name → your name. Keep this file to yourself.', ...key })}>
          <KeyRound /> Save the key (keep private)
        </Button>
      ) : null}
    </>
  );
}

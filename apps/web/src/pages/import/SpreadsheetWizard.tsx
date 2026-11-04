import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, Check, CircleCheck, FileSpreadsheet, RotateCcw, Sparkles, TriangleAlert, Upload } from 'lucide-react';
import {
  AutomationStatus,
  ImportField,
  LIMITS,
  type ImportCommitResponse,
  type ImportPreviewResponse,
  type ImportStatusValuesResponse,
} from '@ptd/shared';
import { useImportCommit, useImportStatusValues } from '../../api/hooks';
import { errorMessage, uploadWithProgress } from '../../api/client';
import { cn, fmtBytes, fmtNumber, pluralize } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Card, CardBody, CardHeader } from '../../components/ui/card';
import { NativeSelect } from '../../components/ui/select';
import { linkButton } from '../../components/ui/link-button';
import { AUTOMATION_META } from '../../components/status';

type Step = 'upload' | 'map' | 'status' | 'review' | 'done';
const STEPS: { key: Step; label: string }[] = [
  { key: 'upload', label: 'Upload' },
  { key: 'map', label: 'Map columns' },
  { key: 'status', label: 'Status values' },
  { key: 'review', label: 'Dry run' },
  { key: 'done', label: 'Done' },
];

const FIELD_LABEL: Record<ImportField, string> = {
  key: 'Key (ID)',
  title: 'Title',
  suite: 'Suite / module',
  priority: 'Priority',
  automationStatus: 'Automation status',
  owner: 'Owner',
  tags: 'Tags',
  externalUrl: 'External URL',
  allureFullName: 'Allure fullName',
  allureId: 'Allure ID',
  jiraKey: 'Jira key',
};

export function SpreadsheetWizard() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('upload');
  const [progress, setProgress] = useState<number | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [sheetName, setSheetName] = useState<string>('');
  const [mapping, setMapping] = useState<Record<string, ImportField | ''>>({});
  const [statusValues, setStatusValues] = useState<ImportStatusValuesResponse['values']>([]);
  const [statusMap, setStatusMap] = useState<Record<string, AutomationStatus>>({});
  const [onConflict, setOnConflict] = useState<'update' | 'skip'>('update');
  const [dryRun, setDryRun] = useState<ImportCommitResponse | null>(null);
  const [result, setResult] = useState<ImportCommitResponse | null>(null);
  const statusQ = useImportStatusValues();
  const commit = useImportCommit();

  const sheet = preview?.sheets.find((s) => s.name === sheetName) ?? preview?.sheets[0];

  const reset = () => {
    setStep('upload');
    setPreview(null);
    setMapping({});
    setStatusValues([]);
    setStatusMap({});
    setDryRun(null);
    setResult(null);
  };

  const chooseSheet = (p: ImportPreviewResponse, name: string) => {
    setSheetName(name);
    const s = p.sheets.find((x) => x.name === name);
    setMapping(Object.fromEntries((s?.headers ?? []).map((h) => [h, s?.suggestedMapping[h] ?? ''])));
  };

  const upload = async (file: File) => {
    if (file.size > LIMITS.uploadMaxBytes) return toast.error(`File is larger than ${fmtBytes(LIMITS.uploadMaxBytes)}.`);
    if (!/\.(xlsx|csv|tsv)$/i.test(file.name)) return toast.error('Choose an .xlsx, .csv or .tsv file.');
    const form = new FormData();
    form.append('file', file, file.name);
    setProgress(0);
    try {
      const p = await uploadWithProgress<ImportPreviewResponse>('/api/test-cases/import/preview', form, setProgress).promise;
      setPreview(p);
      chooseSheet(p, p.sheets[0]?.name ?? '');
      setStep('map');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setProgress(null);
    }
  };

  // Validation of the mapping
  const mapped = Object.entries(mapping).filter(([, f]) => f) as [string, ImportField][];
  const fieldCounts = mapped.reduce<Record<string, number>>((acc, [, f]) => ({ ...acc, [f]: (acc[f] ?? 0) + 1 }), {});
  const duplicates = Object.entries(fieldCounts).filter(([, n]) => n > 1).map(([f]) => f as ImportField);
  const hasTitle = !!fieldCounts.title;
  const statusColumn = mapped.find(([, f]) => f === 'automationStatus')?.[0];
  const mappingError = !hasTitle ? 'Map a column to Title (Key falls back to Title if unmapped).' : duplicates.length ? `Each field can be mapped once: ${duplicates.map((d) => FIELD_LABEL[d]).join(', ')}` : null;

  const cleanMapping = () => Object.fromEntries(mapped) as Record<string, ImportField>;

  const runDry = (sm = statusMap) => {
    if (!preview || !sheet) return;
    setDryRun(null);
    commit.mutate(
      { uploadId: preview.uploadId, sheet: sheet.name, mapping: cleanMapping(), statusValueMap: sm, onConflict, dryRun: true },
      { onSuccess: setDryRun },
    );
  };

  const toStatusOrReview = () => {
    if (!preview || !sheet) return;
    if (statusColumn) {
      statusQ.mutate(
        { uploadId: preview.uploadId, sheet: sheet.name, column: statusColumn },
        {
          onSuccess: (r) => {
            setStatusValues(r.values);
            setStatusMap(Object.fromEntries(r.values.map((v) => [v.raw, v.suggested])));
            setStep('status');
          },
        },
      );
    } else {
      setStep('review');
      runDry({});
    }
  };

  const doCommit = () => {
    if (!preview || !sheet) return;
    commit.mutate(
      { uploadId: preview.uploadId, sheet: sheet.name, mapping: cleanMapping(), statusValueMap: statusMap, onConflict, dryRun: false },
      {
        onSuccess: (r) => {
          setResult(r);
          setStep('done');
          toast.success(`Imported: ${r.created} created, ${r.updated} updated`);
        },
      },
    );
  };

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  return (
    <Card id="spreadsheet" className="scroll-mt-16">
      <CardHeader
        title="Spreadsheet tracker"
        icon={<FileSpreadsheet className="size-4 text-fg-3" aria-hidden />}
        description="Import your existing Excel/CSV inventory. Rows are upserted by key; nothing is written until you confirm."
        actions={
          step !== 'upload' ? (
            <Button size="sm" variant="ghost" onClick={reset}>
              <RotateCcw /> Start over
            </Button>
          ) : null
        }
      />
      <CardBody className="space-y-4">
        <ol className="flex items-center gap-1 overflow-x-auto text-[11px]" aria-label="Import steps">
          {STEPS.map((s, i) => (
            <li key={s.key} className="flex shrink-0 items-center gap-1" aria-current={i === stepIndex ? 'step' : undefined}>
              <span
                className={cn(
                  'grid size-5 place-items-center rounded-full border text-[10px] font-semibold',
                  i < stepIndex ? 'border-accent bg-accent text-accent-fg' : i === stepIndex ? 'border-accent text-accent' : 'border-border text-fg-3',
                )}
              >
                {i < stepIndex ? <Check className="size-3" strokeWidth={3} /> : i + 1}
              </span>
              <span className={cn(i === stepIndex ? 'font-medium text-fg' : 'text-fg-3')}>{s.label}</span>
              {i < STEPS.length - 1 ? <span className="mx-1 h-px w-4 bg-border" aria-hidden /> : null}
            </li>
          ))}
        </ol>

        {step === 'upload' ? (
          <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-border-strong/60 bg-surface-2/40 px-4 py-8 text-center">
            <FileSpreadsheet className="mb-2 size-6 text-fg-3" aria-hidden />
            <p className="text-[13px] font-medium text-fg">Upload your tracker (.xlsx, .csv or .tsv)</p>
            <p className="mt-0.5 text-xs text-fg-3">Formulas are not evaluated — cached values are used. Max 50,000 rows per sheet.</p>
            <Button className="mt-3" variant="outline" size="sm" onClick={() => fileRef.current?.click()} loading={progress !== null}>
              <Upload /> Choose file
            </Button>
            <input
              ref={fileRef}
              type="file"
              className="sr-only"
              tabIndex={-1}
              aria-label="Choose spreadsheet"
              accept=".xlsx,.csv,.tsv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void upload(f);
              }}
            />
            {progress !== null ? (
              <div className="mt-3 h-1.5 w-48 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label="Uploading" aria-valuenow={Math.round(progress * 100)}>
                <div className="h-full bg-accent" style={{ width: `${progress * 100}%` }} />
              </div>
            ) : null}
          </div>
        ) : null}

        {step === 'map' && preview && sheet ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="font-medium text-fg">{preview.fileName}</span>
              {preview.sheets.length > 1 ? (
                <label className="flex items-center gap-1.5 text-xs text-fg-2">
                  Sheet
                  <NativeSelect value={sheet.name} onChange={(e) => chooseSheet(preview, e.target.value)} aria-label="Sheet">
                    {preview.sheets.map((s) => (
                      <option key={s.name} value={s.name}>
                        {s.name} ({fmtNumber(s.rowCount)} rows)
                      </option>
                    ))}
                  </NativeSelect>
                </label>
              ) : null}
              <span className="text-xs text-fg-3">{pluralize(sheet.rowCount, 'row')}</span>
            </div>
            <MappingTable sheet={sheet} mapping={mapping} setMapping={setMapping} duplicates={duplicates} />
            {mappingError ? (
              <p className="flex items-center gap-1.5 text-xs text-bad" role="alert">
                <TriangleAlert className="size-3.5" aria-hidden /> {mappingError}
              </p>
            ) : null}
            <div className="flex justify-end">
              <Button variant="primary" disabled={!!mappingError} onClick={toStatusOrReview} loading={statusQ.isPending || commit.isPending}>
                Continue <ArrowRight />
              </Button>
            </div>
          </div>
        ) : null}

        {step === 'status' ? (
          <div className="space-y-3">
            <p className="text-[13px] text-fg-2">
              Map each distinct value in <b className="font-medium text-fg">{statusColumn}</b> to an automation status. We pre-filled our best guesses.
            </p>
            <div className="max-h-80 overflow-auto rounded-lg border border-border">
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 bg-surface-2 text-left text-[11px] font-medium tracking-wide text-fg-3 uppercase">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">Value in sheet</th>
                    <th className="px-3 py-1.5 text-right font-medium">Rows</th>
                    <th className="px-3 py-1.5 font-medium">Maps to</th>
                  </tr>
                </thead>
                <tbody>
                  {statusValues.map((v) => (
                    <tr key={v.raw} className="border-t border-border">
                      <td className="px-3 py-1.5 font-mono text-xs text-fg">{v.raw === '' ? <span className="text-fg-3 italic">(blank)</span> : v.raw}</td>
                      <td className="px-3 py-1.5 text-right text-xs text-fg-2 tabular">{fmtNumber(v.count)}</td>
                      <td className="px-3 py-1.5">
                        <NativeSelect
                          aria-label={`Status for “${v.raw}”`}
                          value={statusMap[v.raw] ?? v.suggested}
                          onChange={(e) => setStatusMap({ ...statusMap, [v.raw]: e.target.value as AutomationStatus })}
                          className="w-44"
                        >
                          {AutomationStatus.options.map((s) => (
                            <option key={s} value={s}>
                              {AUTOMATION_META[s].label}
                            </option>
                          ))}
                        </NativeSelect>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep('map')}>
                <ArrowLeft /> Back
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setStep('review');
                  runDry();
                }}
              >
                Dry run <ArrowRight />
              </Button>
            </div>
          </div>
        ) : null}

        {step === 'review' ? (
          <div className="space-y-3">
            <fieldset className="flex flex-wrap items-center gap-3 text-[13px]">
              <legend className="mb-1 text-xs font-medium text-fg-2">When a key already exists</legend>
              {(['update', 'skip'] as const).map((o) => (
                <label key={o} className="inline-flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="onConflict"
                    value={o}
                    checked={onConflict === o}
                    onChange={() => setOnConflict(o)}
                    className="accent-[var(--accent)]"
                  />
                  {o === 'update' ? 'Update existing cases' : 'Skip existing cases'}
                </label>
              ))}
              <Button size="sm" variant="outline" onClick={() => runDry()} loading={commit.isPending && !result}>
                Re-run dry run
              </Button>
            </fieldset>
            {dryRun ? <CommitSummary r={dryRun} /> : <div className="h-20 animate-pulse rounded-lg bg-surface-2" aria-label="Running dry run" />}
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep(statusColumn ? 'status' : 'map')}>
                <ArrowLeft /> Back
              </Button>
              <Button variant="primary" onClick={doCommit} disabled={!dryRun || dryRun.created + dryRun.updated === 0} loading={commit.isPending && !!dryRun}>
                Import {dryRun ? pluralize(dryRun.created + dryRun.updated, 'row') : ''}
              </Button>
            </div>
          </div>
        ) : null}

        {step === 'done' && result ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
              <CircleCheck className="size-5 text-st-passed" aria-hidden /> Import complete
            </div>
            <CommitSummary r={result} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={reset}>
                Import another file
              </Button>
              <Link to="/tests" className={linkButton('primary')}>
                View test cases <ArrowRight />
              </Link>
            </div>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function MappingTable({
  sheet,
  mapping,
  setMapping,
  duplicates,
}: {
  sheet: ImportPreviewResponse['sheets'][number];
  mapping: Record<string, ImportField | ''>;
  setMapping: (m: Record<string, ImportField | ''>) => void;
  duplicates: ImportField[];
}) {
  const samples = useMemo(
    () =>
      sheet.headers.map((_, i) =>
        sheet.sampleRows
          .map((r) => r[i] ?? '')
          .filter((v) => v.trim() !== '')
          .slice(0, 3),
      ),
    [sheet],
  );
  return (
    <div className="max-h-[420px] overflow-auto rounded-lg border border-border">
      <table className="w-full text-[13px]">
        <thead className="sticky top-0 z-10 bg-surface-2 text-left text-[11px] font-medium tracking-wide text-fg-3 uppercase">
          <tr>
            <th className="px-3 py-1.5 font-medium">Column</th>
            <th className="hidden px-3 py-1.5 font-medium sm:table-cell">Sample values</th>
            <th className="px-3 py-1.5 font-medium">Import as</th>
          </tr>
        </thead>
        <tbody>
          {sheet.headers.map((h, i) => {
            const v = mapping[h] ?? '';
            const suggested = sheet.suggestedMapping[h];
            const dup = v && duplicates.includes(v);
            return (
              <tr key={`${h}-${i}`} className="border-t border-border align-top">
                <td className="px-3 py-2">
                  <div className="font-medium text-fg">{h || <span className="text-fg-3 italic">(no header)</span>}</div>
                  <div className="mt-0.5 truncate text-[11px] text-fg-3 sm:hidden">{samples[i]?.join(' · ')}</div>
                </td>
                <td className="hidden max-w-56 px-3 py-2 sm:table-cell">
                  <div className="flex flex-wrap gap-1">
                    {samples[i]?.length ? (
                      samples[i]!.map((s, j) => (
                        <span key={j} className="max-w-full truncate rounded border border-border bg-surface-2 px-1 py-px font-mono text-[11px] text-fg-2">
                          {s}
                        </span>
                      ))
                    ) : (
                      <span className="text-[11px] text-fg-3">empty</span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <NativeSelect
                    aria-label={`Field for column ${h}`}
                    value={v}
                    onChange={(e) => setMapping({ ...mapping, [h]: e.target.value as ImportField | '' })}
                    className={cn('w-44', dup && '[&_select]:border-st-failed')}
                  >
                    <option value="">Ignore</option>
                    {ImportField.options.map((f) => (
                      <option key={f} value={f}>
                        {FIELD_LABEL[f]}
                      </option>
                    ))}
                  </NativeSelect>
                  {suggested && v === suggested ? (
                    <div className="mt-1 inline-flex items-center gap-1 text-[10px] text-fg-3">
                      <Sparkles className="size-3" aria-hidden /> suggested
                    </div>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CommitSummary({ r }: { r: ImportCommitResponse }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          { l: r.dryRun ? 'Will create' : 'Created', v: r.created },
          { l: r.dryRun ? 'Will update' : 'Updated', v: r.updated },
          { l: r.dryRun ? 'Will skip' : 'Skipped', v: r.skipped },
        ].map((x) => (
          <div key={x.l}>
            <div className="text-xl font-semibold text-fg tabular">{fmtNumber(x.v)}</div>
            <div className="text-[11px] text-fg-3">{x.l}</div>
          </div>
        ))}
      </div>
      {r.errors.length > 0 ? (
        <div className="mt-3 border-t border-border pt-2">
          <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-bad">
            <TriangleAlert className="size-3.5" aria-hidden /> {pluralize(r.errors.length, 'row')} with problems{r.errors.length >= 100 ? ' (first 100)' : ''} — other rows still import
          </p>
          <ul className="max-h-40 space-y-0.5 overflow-auto text-xs text-fg-2">
            {r.errors.map((e, i) => (
              <li key={i}>
                <span className="font-mono text-fg-3">Row {e.row}:</span> {e.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

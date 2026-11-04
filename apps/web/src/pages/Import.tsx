import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { Link, useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowRight,

  CircleCheck,
  Copy,
  FileArchive,

  FolderUp,
  Terminal,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react';
import { LIMITS, RunImportFields, type RunImportResponse } from '@ptd/shared';
import { invalidateAfterRunImport, useMeta } from '../api/hooks';
import { errorMessage, uploadWithProgress, type UploadHandle } from '../api/client';
import { filesFromDataTransfer, planAllureUpload, type AllureSelection } from '../lib/allureFiles';
import { cn, fmtBytes, fmtNumber, fmtPct, pluralize } from '../lib/utils';
import { Button } from '../components/ui/button';
import { Card, CardBody, CardHeader } from '../components/ui/card';
import { Field, Input } from '../components/ui/input';
import { PageHeader } from '../components/ui/misc';
import { linkButton } from '../components/ui/link-button';
import { RunChangeChips } from '../components/ChangeBadge';
import { RunGroupChip } from '../components/RunGroup';
import { SpreadsheetWizard } from './import/SpreadsheetWizard';

export default function ImportPage() {
  const { hash } = useLocation();
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash]);
  return (
    <>
      <PageHeader title="Import" description="Bring in test results from pytest/Allure and your existing test inventory from Excel or CSV." />
      <div className="grid gap-4 xl:grid-cols-2">
        <AllureCard />
        <SpreadsheetWizard />
      </div>
      <CiSnippet />
    </>
  );
}

// ---------------------------------------------------------------------------
// Allure results

function ProgressBar({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-fg-2">
        <span>{label}</span>
        <span className="tabular">{fmtPct(value)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${value * 100}%` }} />
      </div>
    </div>
  );
}

function AllureCard() {
  const id = useId();
  const qc = useQueryClient();
  const meta = useMeta();
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [plan, setPlan] = useState<AllureSelection | null>(null);
  const [fields, setFields] = useState({ name: '', runGroup: '', branch: '', commit: '', buildUrl: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<RunImportResponse | null>(null);
  const handle = useRef<UploadHandle<RunImportResponse> | null>(null);

  const accept = (files: File[]) => {
    setResult(null);
    setPlan(planAllureUpload(files));
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    setScanning(true);
    try {
      accept(await filesFromDataTransfer(e.dataTransfer));
    } catch {
      toast.error('Could not read the dropped folder. Try “Choose folder” instead.');
    } finally {
      setScanning(false);
    }
  };

  const upload = async () => {
    if (!plan || plan.files.length === 0) return;
    const parsed = RunImportFields.extend({ runGroup: RunImportFields.shape.name }).safeParse({
      name: fields.name.trim() || undefined,
      runGroup: fields.runGroup.trim() || undefined,
      branch: fields.branch.trim() || null,
      commit: fields.commit.trim() || null,
      buildUrl: fields.buildUrl.trim() || null,
    });
    if (!parsed.success) {
      const e: Record<string, string> = {};
      parsed.error.issues.forEach((i) => (e[String(i.path[0])] ??= i.message));
      return setErrors(e);
    }
    setErrors({});
    const form = new FormData();
    // Fields first (the server reads them before streaming files).
    for (const [k, v] of Object.entries(parsed.data)) if (v) form.append(k, String(v));
    for (const f of plan.files) form.append('file', f, f.name.split(/[\\/]/).pop());
    setProgress(0);
    handle.current = uploadWithProgress<RunImportResponse>('/api/runs/import', form, setProgress);
    try {
      const res = await handle.current.promise;
      setResult(res);
      setPlan(null);
      invalidateAfterRunImport(qc);
      toast.success(`Imported “${res.run.name}”`, { description: `${pluralize(res.run.counts.total, 'result')} · pass rate ${fmtPct(res.run.passRate, 1)}` });
    } catch (e) {
      if (!(e instanceof Error && e.message === 'Upload cancelled.')) toast.error(errorMessage(e));
    } finally {
      setProgress(null);
      handle.current = null;
    }
  };

  const uploading = progress !== null;

  return (
    <Card id="allure" className="scroll-mt-16">
      <CardHeader
        title="Allure results"
        icon={<FolderUp className="size-4 text-fg-3" aria-hidden />}
        description="Upload a pytest allure-results folder or a .zip of it. Only result files are sent — screenshots and attachments are skipped."
      />
      <CardBody className="space-y-4">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => void onDrop(e)}
          className={cn(
            'flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors',
            dragging ? 'border-accent bg-accent-soft' : 'border-border-strong/60 bg-surface-2/40',
          )}
        >
          <Upload className="mb-2 size-6 text-fg-3" aria-hidden />
          <p className="text-[13px] font-medium text-fg">{scanning ? 'Reading folder…' : 'Drop an allure-results folder or .zip here'}</p>
          <p className="mt-0.5 text-xs text-fg-3">Up to {fmtBytes(LIMITS.uploadMaxBytes)} · {fmtNumber(LIMITS.uploadMaxFiles)} files</p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <Button size="sm" variant="outline" onClick={() => folderInput.current?.click()} disabled={uploading}>
              <FolderUp /> Choose folder
            </Button>
            <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()} disabled={uploading}>
              <FileArchive /> Choose .zip or files
            </Button>
          </div>
          <input
            ref={folderInput}
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-label="Choose allure-results folder"
            multiple
            {...{ webkitdirectory: '', directory: '' }}
            onChange={(e) => {
              accept(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <input
            ref={fileInput}
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-label="Choose zip or result files"
            multiple
            accept=".zip,.json,.properties,application/zip"
            onChange={(e) => {
              accept(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        </div>

        {plan ? (
          <div className={cn('flex items-start gap-3 rounded-lg border px-3 py-2.5 text-[13px]', plan.error ? 'border-[color-mix(in_oklab,var(--st-failed)_35%,transparent)]' : 'border-border')}>
            {plan.error ? <TriangleAlert className="mt-0.5 size-4 shrink-0 text-st-failed" aria-hidden /> : plan.kind === 'zip' ? <FileArchive className="mt-0.5 size-4 shrink-0 text-fg-3" aria-hidden /> : <CircleCheck className="mt-0.5 size-4 shrink-0 text-st-passed" aria-hidden />}
            <div className="min-w-0 flex-1">
              {plan.error ? (
                <p className="text-fg">{plan.error}</p>
              ) : plan.kind === 'zip' ? (
                <p className="text-fg">
                  <b className="font-medium">{plan.files[0]!.name}</b> · {fmtBytes(plan.totalBytes)}
                </p>
              ) : (
                <p className="text-fg">
                  <b className="font-medium">{pluralize(plan.resultCount, 'result file')}</b> ({pluralize(plan.files.length, 'file')}, {fmtBytes(plan.totalBytes)}) ready
                </p>
              )}
              {plan.ignored > 0 ? <p className="text-xs text-fg-3">{pluralize(plan.ignored, 'other file')} (attachments etc.) will be skipped</p> : null}
            </div>
            <Button size="icon-sm" variant="ghost" aria-label="Clear selection" onClick={() => setPlan(null)} disabled={uploading}>
              <X />
            </Button>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Run name" htmlFor={`${id}-name`} hint="Default: executor build name or import time" error={errors.name}>
            <Input id={`${id}-name`} value={fields.name} maxLength={LIMITS.shortTextMax} onChange={(e) => setFields({ ...fields, name: e.target.value })} placeholder="Nightly #412" />
          </Field>
          <Field label="Run group" htmlFor={`${id}-group`} hint="Blank = auto-detect from the tests’ folder" error={errors.runGroup}>
            <Input id={`${id}-group`} list={`${id}-groups`} value={fields.runGroup} maxLength={LIMITS.shortTextMax} onChange={(e) => setFields({ ...fields, runGroup: e.target.value })} placeholder="auto-detect" className="font-mono" />
            <datalist id={`${id}-groups`}>
              {meta.data?.runGroups.map((g) => <option key={g.name} value={g.name}>{`${g.runs} runs`}</option>)}
            </datalist>
          </Field>
          <Field label="Branch" htmlFor={`${id}-branch`} error={errors.branch}>
            <Input id={`${id}-branch`} list={`${id}-branches`} value={fields.branch} maxLength={LIMITS.shortTextMax} onChange={(e) => setFields({ ...fields, branch: e.target.value })} placeholder="main" className="font-mono" />
            <datalist id={`${id}-branches`}>
              {meta.data?.branches.map((b) => <option key={b} value={b} />)}
            </datalist>
          </Field>
          <Field label="Commit" htmlFor={`${id}-commit`} error={errors.commit}>
            <Input id={`${id}-commit`} value={fields.commit} maxLength={LIMITS.shortTextMax} onChange={(e) => setFields({ ...fields, commit: e.target.value })} className="font-mono" />
          </Field>
          <Field label="Build URL" htmlFor={`${id}-build`} error={errors.buildUrl} className="sm:col-span-2">
            <Input id={`${id}-build`} type="url" value={fields.buildUrl} maxLength={LIMITS.urlMax} onChange={(e) => setFields({ ...fields, buildUrl: e.target.value })} placeholder="https://ci.example.com/job/123" />
          </Field>
        </div>

        {uploading ? <ProgressBar value={progress} label={progress < 1 ? 'Uploading…' : 'Processing on server…'} /> : null}

        <div className="flex justify-end gap-2">
          {uploading ? (
            <Button variant="ghost" onClick={() => handle.current?.abort()}>
              Cancel
            </Button>
          ) : null}
          <Button variant="primary" onClick={() => void upload()} disabled={!plan || plan.files.length === 0} loading={uploading}>
            <Upload /> Upload results
          </Button>
        </div>

        {result ? <ImportResult r={result} /> : null}
      </CardBody>
    </Card>
  );
}

function ImportResult({ r }: { r: RunImportResponse }) {
  return (
    <div className="rounded-lg border border-[color-mix(in_oklab,var(--st-passed)_30%,transparent)] bg-[color-mix(in_oklab,var(--st-passed)_6%,transparent)] p-3" role="status">
      <div className="flex flex-wrap items-center gap-2">
        <CircleCheck className="size-4 text-st-passed" aria-hidden />
        <span className="text-[13px] font-medium text-fg">Imported “{r.run.name}”</span>
        <RunGroupChip group={r.run.runGroup} />
        <Link to={`/runs/${r.run.id}`} className={cn(linkButton('outline', 'sm'), 'ml-auto')}>
          Open run <ArrowRight />
        </Link>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-2 tabular">
        <span>
          <b className="text-fg">{fmtNumber(r.run.counts.total)}</b> results
        </span>
        <span>
          <b className="text-fg">{fmtPct(r.run.passRate, 1)}</b> pass rate
        </span>
        <span>
          <b className="text-fg">{r.createdTestCases}</b> cases created
        </span>
        <span>
          <b className="text-fg">{r.promotedTestCases}</b> promoted to automated
        </span>
        {r.skippedFiles > 0 ? <span>{r.skippedFiles} files skipped</span> : null}
        {r.run.previousRunId ? <RunChangeChips changes={r.run.changes} /> : null}
      </div>
      {r.warnings.length > 0 ? (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-fg-2">{pluralize(r.warnings.length, 'note')} from the import</summary>
          <ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-auto pl-5 text-fg-2">
            {r.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function CiSnippet() {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://dashboard.example.com';
  const snippet = `# From your CI job, after pytest --alluredir=allure-results
# Use the upload-only INGEST_TOKEN (never the editor token) as a CI secret.
# --form-string: a branch name starting with @ must not make curl read a file.
cd allure-results && zip -qr ../allure-results.zip . && cd ..
curl -fsS -X POST "${origin}/api/runs/import" \\
  -H "Authorization: Bearer $PTD_INGEST_TOKEN" \\
  --form-string "name=$CI_PIPELINE_NAME #$CI_BUILD_NUMBER" \\
  --form-string "runGroup=regression" \\
  --form-string "branch=$GIT_BRANCH" \\
  --form-string "commit=$GIT_COMMIT" \\
  --form-string "buildUrl=$BUILD_URL" \\
  -F "file=@allure-results.zip"`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Copy failed — select the text and copy manually.');
    }
  };
  return (
    <Card className="mt-4">
      <CardHeader
        title="Upload from CI"
        icon={<Terminal className="size-4 text-fg-3" aria-hidden />}
        description="Store DASHBOARD_TOKEN as a CI secret — never commit it. Fields are sent before the file."
        actions={
          <Button size="sm" variant="outline" onClick={() => void copy()}>
            <Copy /> Copy
          </Button>
        }
      />
      <CardBody>
        <pre className="overflow-x-auto rounded-lg border border-border bg-surface-2/60 p-3 font-mono text-xs leading-relaxed text-fg">{snippet}</pre>
      </CardBody>
    </Card>
  );
}


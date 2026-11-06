import { FlaskConical, Folder, GitBranch } from 'lucide-react';
import { useTriggerOverview } from '../api/hooks';
import { Select } from './ui/select';
import { cn, fmtNumber } from '../lib/utils';

/**
 * What the page counts: a branch of the trigger repo (shown once several branches have a route
 * scan) and a folder in it (shown once the branch has several folders, or one is picked).
 * `onBranch(null)` / `onFolder(null)` go back to the default branch / the whole branch.
 */
export function ScopePicker({
  branch,
  folder,
  tests,
  onBranch,
  onFolder,
  onTests,
  className,
}: {
  branch: string | null | undefined;
  folder: string | null | undefined;
  /** Test repo branch (null = the same name as the routes branch). */
  tests?: string | null;
  onBranch: (branch: string | null) => void;
  onFolder: (folder: string | null) => void;
  onTests?: (tests: string | null) => void;
  className?: string;
}) {
  const q = useTriggerOverview(undefined, 1, branch);
  const branches = q.data?.routeBranches ?? [];
  const def = q.data?.defaultBranch ?? null;
  const folders = q.data?.folders ?? [];
  const folderOptions = folders.map((f) => ({ value: f.folder, label: `${f.folder} · ${fmtNumber(f.tested)}/${fmtNumber(f.triggers)} tested` }));
  if (folder && !folders.some((f) => f.folder === folder)) folderOptions.unshift({ value: folder, label: `${folder} · not on this branch` });
  const testBranches = q.data?.testBranches ?? [];
  const showBranch = branches.length > 1;
  const showFolder = folders.length > 1 || !!folder;
  const showTests = !!onTests && (testBranches.length > 1 || !!tests);
  if (!showBranch && !showFolder && !showTests) return null;
  return (
    <div className={cn('inline-flex flex-wrap items-center gap-2', className)}>
      {showBranch ? (
        <span className="inline-flex items-center gap-1.5">
          <GitBranch className="size-3.5 text-fg-3" aria-hidden />
          <Select
            size="sm"
            ariaLabel="Trigger repo branch"
            value={branch && branches.includes(branch) ? branch : def}
            onValueChange={(v) => onBranch(!v || v === def ? null : v)}
            options={branches.map((b) => ({ value: b, label: b === def ? `${b} (default)` : b }))}
            className="w-40"
          />
        </span>
      ) : null}
      {showTests ? (
        <span className="inline-flex items-center gap-1.5" title="Test repo branch: its merged tests count, plus the open PRs into it">
          <FlaskConical className="size-3.5 text-fg-3" aria-hidden />
          <Select
            size="sm"
            ariaLabel="Tests branch"
            value={tests ?? null}
            onValueChange={(v) => onTests?.(v)}
            options={[...new Set([...testBranches, ...(tests ? [tests] : [])])].map((b) => ({ value: b, label: `tests from ${b}` }))}
            allowNone
            noneLabel="tests: same as routes"
            className="w-48"
          />
        </span>
      ) : null}
      {showFolder ? (
        <span className="inline-flex items-center gap-1.5">
          <Folder className="size-3.5 text-fg-3" aria-hidden />
          <Select
            size="sm"
            ariaLabel="Folder"
            value={folder ?? null}
            onValueChange={(v) => onFolder(v)}
            options={folderOptions}
            allowNone
            noneLabel="All folders"
            className="w-56"
          />
        </span>
      ) : null}
    </div>
  );
}

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type { z } from 'zod';
import type {
  AutomationStatus,
  Bug,
  BugCreate,
  BugList,
  BugQuery,
  BugStats,
  BugUpdate,
  FailureGroup,
  HistoryMatrix,
  HistoryMatrixQuery,
  TriggerGithubInfo,
  TriggerGithubScanRequest,
  TriggerListResponse,
  TriggerOverviewResponse,
  PrScanStatus,
  UnlinkedTestsResponse,
  RouteStatus,
  TriggerQuery,
  TriggerScanResponse,
  RunComparison,
  RunUpdate,
  ImportCommitRequest,
  ImportCommitResponse,
  ImportPreviewResponse,
  ImportStatusValuesResponse,
  IntegrationName,
  IntegrationStatus,
  LoginRequest,
  Meta,
  Note,
  NoteBulkCreate,
  NoteCreate,
  NoteUpdate,
  PullRequest,
  PullRequestQuery,
  Report,
  Run,
  RunList,
  RunQuery,
  RunResultsQuery,
  SessionInfo,
  ScopePreset,
  ScopePresets,
  Settings,
  Summary,
  TestCase,
  TestCaseBulkUpdate,
  TestCaseCreate,
  TestCaseDetail,
  TestCaseList,
  TestCaseQuery,
  TestCaseUpdate,
  TestResult,
  TestResultList,
} from '@ptd/shared';
import { api } from './client';

// Query params are serialized with String(), so the parsed (output) shapes are what callers build.
type In<T extends z.ZodTypeAny> = Partial<z.output<T>>;
export type TestCaseQueryInput = In<typeof TestCaseQuery>;
export type RunQueryInput = In<typeof RunQuery>;
export type RunResultsQueryInput = In<typeof RunResultsQuery>;
export type PullRequestQueryInput = In<typeof PullRequestQuery>;
export type BugQueryInput = In<typeof BugQuery>;
export type HistoryMatrixQueryInput = In<typeof HistoryMatrixQuery>;
export type TriggerQueryInput = In<typeof TriggerQuery>;

export const qk = {
  session: ['session'] as const,
  summary: ['summary'] as const,
  meta: ['meta'] as const,
  testCases: (q?: TestCaseQueryInput) => (q ? (['testCases', q] as const) : (['testCases'] as const)),
  testCase: (id: number) => ['testCase', id] as const,
  runs: (q?: RunQueryInput) => (q ? (['runs', q] as const) : (['runs'] as const)),
  run: (id: number) => ['run', id] as const,
  runResults: (id: number, q?: RunResultsQueryInput) =>
    q ? (['runResults', id, q] as const) : (['runResults', id] as const),
  runFailures: (id: number) => ['runFailures', id] as const,
  result: (id: number) => ['result', id] as const,
  compare: (head: number, base?: number) => ['compare', head, base ?? null] as const,
  matrix: (q: HistoryMatrixQueryInput) => ['matrix', q] as const,
  bugs: (q?: BugQueryInput) => (q ? (['bugs', q] as const) : (['bugs'] as const)),
  bugStats: ['bugStats'] as const,
  integrations: ['integrations'] as const,
  pullRequests: (q?: PullRequestQueryInput) => (q ? (['pullRequests', q] as const) : (['pullRequests'] as const)),
  report: (periodDays: number) => ['report', periodDays] as const,
  settings: ['settings'] as const,
  triggers: (q: TriggerQueryInput) => ['triggers', q] as const,
};

/** Everything derived from the test-case inventory. */
function invalidateInventory(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ['testCases'] });
  void qc.invalidateQueries({ queryKey: ['testCase'] });
  void qc.invalidateQueries({ queryKey: qk.summary });
  void qc.invalidateQueries({ queryKey: qk.meta });
  void qc.invalidateQueries({ queryKey: ['report'] });
}

function invalidateRuns(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ['runs'] });
  void qc.invalidateQueries({ queryKey: ['run'] });
  void qc.invalidateQueries({ queryKey: ['runResults'] });
  void qc.invalidateQueries({ queryKey: ['runFailures'] });
  void qc.invalidateQueries({ queryKey: ['compare'] });
  void qc.invalidateQueries({ queryKey: ['matrix'] });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export function useSession() {
  return useQuery({
    queryKey: qk.session,
    queryFn: ({ signal }) => api.get<SessionInfo>('/api/auth/session', undefined, signal),
    staleTime: 60_000,
    retry: 1,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) => api.post<void>('/api/auth/login', body),
    onSuccess: async () => {
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
      await qc.invalidateQueries({ queryKey: qk.session });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>('/api/auth/logout'),
    onSettled: async () => {
      qc.clear();
      await qc.invalidateQueries({ queryKey: qk.session });
    },
  });
}

// ---------------------------------------------------------------------------
// Summary / meta / report / settings
// ---------------------------------------------------------------------------

/** `branch`: the trigger repo branch to count (undefined = the default branch). */
export function useSummary(branch?: string | null, folder?: string | null, tests?: string | null, kinds?: string | null, exclude?: string | null) {
  return useQuery({
    queryKey: [...qk.summary, branch ?? null, folder ?? null, tests ?? null, kinds ?? null, exclude ?? null],
    queryFn: ({ signal }) =>
      api.get<Summary>('/api/summary', { ...(branch ? { branch } : {}), ...(folder ? { folder } : {}), ...(tests ? { tests } : {}), ...(kinds ? { kinds } : {}), ...(exclude ? { exclude } : {}) }, signal),
    placeholderData: keepPreviousData,
  });
}

export function useMeta() {
  return useQuery({
    queryKey: qk.meta,
    queryFn: ({ signal }) => api.get<Meta>('/api/meta', undefined, signal),
    staleTime: 5 * 60_000,
  });
}

export function useReport(periodDays: number, branch?: string | null, folder?: string | null, tests?: string | null, kinds?: string | null, exclude?: string | null) {
  return useQuery({
    queryKey: [...qk.report(periodDays), branch ?? null, folder ?? null, tests ?? null, kinds ?? null, exclude ?? null],
    queryFn: ({ signal }) =>
      api.get<Report>('/api/report', { periodDays, ...(branch ? { branch } : {}), ...(folder ? { folder } : {}), ...(tests ? { tests } : {}), ...(kinds ? { kinds } : {}), ...(exclude ? { exclude } : {}) }, signal),
    placeholderData: keepPreviousData,
  });
}

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: ({ signal }) => api.get<Settings>('/api/settings', undefined, signal) });
}

/** Saved filters: folders + kinds + exclusion under a name, with the routes they held when saved. */
export function useScopePresets() {
  return useQuery({ queryKey: ['scope-presets'], queryFn: ({ signal }) => api.get<ScopePresets>('/api/scope-presets', undefined, signal) });
}

/** Replace the saved filters (a new or changed one gets its baseline on `branch`). */
export function useSaveScopePresets() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ presets, branch }: { presets: ScopePreset[]; branch?: string | null }) =>
      api.put<ScopePresets>(`/api/scope-presets${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`, { presets }),
    onSuccess: (data) => {
      qc.setQueryData(['scope-presets'], data);
      void qc.invalidateQueries({ queryKey: ['triggers', 'overview'] });
    },
  });
}

/** "Mark as seen": a saved filter's routes now become its baseline. */
export function useMarkPresetSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, branch }: { id: string; branch?: string | null }) =>
      api.post<ScopePresets>(`/api/scope-presets/${encodeURIComponent(id)}/seen${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`),
    onSuccess: (data) => {
      qc.setQueryData(['scope-presets'], data);
      void qc.invalidateQueries({ queryKey: ['triggers', 'overview'] });
    },
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Settings) => api.put<Settings>('/api/settings', body),
    onSuccess: (data) => {
      qc.setQueryData(qk.settings, data);
      void qc.invalidateQueries({ queryKey: ['report'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

export function useTestCases(q: TestCaseQueryInput, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.testCases(q),
    queryFn: ({ signal }) => api.get<TestCaseList>('/api/test-cases', q, signal),
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
  });
}

export function useTestCase(id: number) {
  return useQuery({
    queryKey: qk.testCase(id),
    queryFn: ({ signal }) => api.get<TestCaseDetail>(`/api/test-cases/${id}`, undefined, signal),
    enabled: Number.isFinite(id) && id > 0,
  });
}

export function useCreateTestCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: z.input<typeof TestCaseCreate>) => api.post<TestCase>('/api/test-cases', body),
    onSuccess: () => invalidateInventory(qc),
  });
}

export function useUpdateTestCase(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: TestCaseUpdate) => api.patch<TestCase>(`/api/test-cases/${id}`, patch),
    onSuccess: () => invalidateInventory(qc),
  });
}

/** Inline automation-status edit with an optimistic update across every cached list. */
export function useSetAutomationStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: number; status: AutomationStatus }) =>
      api.patch<TestCase>(`/api/test-cases/${id}`, { automationStatus: status }),
    onMutate: async ({ id, status }) => {
      await qc.cancelQueries({ queryKey: ['testCases'] });
      await qc.cancelQueries({ queryKey: qk.testCase(id) });
      const lists = qc.getQueriesData<TestCaseList>({ queryKey: ['testCases'] });
      const detail = qc.getQueryData<TestCaseDetail>(qk.testCase(id));
      qc.setQueriesData<TestCaseList>({ queryKey: ['testCases'] }, (old) =>
        old ? { ...old, items: old.items.map((t) => (t.id === id ? { ...t, automationStatus: status } : t)) } : old,
      );
      if (detail) qc.setQueryData<TestCaseDetail>(qk.testCase(id), { ...detail, automationStatus: status });
      return { lists, detail };
    },
    onError: (_e, { id }, ctx) => {
      ctx?.lists.forEach(([key, data]) => qc.setQueryData(key, data));
      if (ctx?.detail) qc.setQueryData(qk.testCase(id), ctx.detail);
    },
    onSettled: () => invalidateInventory(qc),
  });
}

export function useDeleteTestCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/api/test-cases/${id}`),
    onSuccess: (_d, id) => {
      qc.removeQueries({ queryKey: qk.testCase(id) });
      invalidateInventory(qc);
      invalidateRuns(qc);
    },
  });
}

export function useBulkUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TestCaseBulkUpdate) => api.post<{ updated: number }>('/api/test-cases/bulk-update', body),
    onSuccess: () => invalidateInventory(qc),
  });
}

// Spreadsheet import (preview upload goes through uploadWithProgress)
export function useImportStatusValues() {
  return useMutation({
    mutationFn: (body: { uploadId: string; sheet: string; column: string }) =>
      api.post<ImportStatusValuesResponse>('/api/test-cases/import/status-values', body),
  });
}

export function useImportCommit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: z.input<typeof ImportCommitRequest>) =>
      api.post<ImportCommitResponse>('/api/test-cases/import/commit', body),
    onSuccess: (res) => {
      if (!res.dryRun) invalidateInventory(qc);
    },
  });
}
export type { ImportPreviewResponse };

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export function useRuns(q: RunQueryInput) {
  return useQuery({
    queryKey: qk.runs(q),
    queryFn: ({ signal }) => api.get<RunList>('/api/runs', q, signal),
    placeholderData: keepPreviousData,
  });
}

export function useRun(id: number) {
  return useQuery({
    queryKey: qk.run(id),
    queryFn: ({ signal }) => api.get<Run>(`/api/runs/${id}`, undefined, signal),
    enabled: id > 0,
  });
}

export function useRunResults(id: number, q: RunResultsQueryInput, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.runResults(id, q),
    queryFn: ({ signal }) => api.get<TestResultList>(`/api/runs/${id}/results`, q, signal),
    placeholderData: keepPreviousData,
    enabled: id > 0 && (opts.enabled ?? true),
  });
}

/** A single result with its full message + trace (`GET /api/results/:id`). */
export function useResult(id: number, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.result(id),
    queryFn: ({ signal }) => api.get<TestResult>(`/api/results/${id}`, undefined, signal),
    enabled: id > 0 && (opts.enabled ?? true),
    staleTime: 5 * 60_000,
  });
}

export function useRunFailures(id: number) {
  return useQuery({
    queryKey: qk.runFailures(id),
    queryFn: ({ signal }) => api.get<FailureGroup[]>(`/api/runs/${id}/failures`, undefined, signal),
    enabled: id > 0,
  });
}

export function useDeleteRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/api/runs/${id}`),
    onSuccess: (_d, id) => {
      qc.removeQueries({ queryKey: qk.run(id) });
      invalidateRuns(qc);
      invalidateInventory(qc);
    },
  });
}

export function useUpdateRun(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: RunUpdate) => api.patch<Run>(`/api/runs/${id}`, patch),
    onSuccess: (run) => {
      qc.setQueryData(qk.run(id), run);
      invalidateRuns(qc);
      void qc.invalidateQueries({ queryKey: qk.meta });
      void qc.invalidateQueries({ queryKey: qk.summary });
    },
  });
}

/** Diff two runs. Omit base to compare against head's previous run. */
export function useCompare(head: number | null, base?: number | null) {
  return useQuery({
    queryKey: qk.compare(head ?? 0, base ?? undefined),
    queryFn: ({ signal }) =>
      api.get<RunComparison>('/api/runs/compare', { head, base: base ?? undefined }, signal),
    enabled: !!head,
    placeholderData: keepPreviousData,
  });
}

export function useHistoryMatrix(q: HistoryMatrixQueryInput, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.matrix(q),
    queryFn: ({ signal }) => api.get<HistoryMatrix>('/api/history/matrix', q, signal),
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
  });
}

/** Call after a successful allure upload. */
export function invalidateAfterRunImport(qc: QueryClient) {
  invalidateRuns(qc);
  invalidateInventory(qc);
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

function invalidateNotes(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ['testCase'] });
  void qc.invalidateQueries({ queryKey: ['testCases'] });
  void qc.invalidateQueries({ queryKey: ['runFailures'] });
  void qc.invalidateQueries({ queryKey: qk.summary });
  void qc.invalidateQueries({ queryKey: ['report'] });
}

export function useCreateNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NoteCreate) => api.post<Note>('/api/notes', body),
    onSuccess: () => invalidateNotes(qc),
  });
}

export function useBulkNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NoteBulkCreate) => api.post<{ created: number }>('/api/notes/bulk', body),
    onSuccess: () => invalidateNotes(qc),
  });
}

export function useUpdateNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: NoteUpdate }) => api.patch<Note>(`/api/notes/${id}`, patch),
    onSuccess: () => invalidateNotes(qc),
  });
}

export function useDeleteNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/api/notes/${id}`),
    onSuccess: () => invalidateNotes(qc),
  });
}

// ---------------------------------------------------------------------------
// Integrations & pull requests
// ---------------------------------------------------------------------------

export function useIntegrations() {
  return useQuery({
    queryKey: qk.integrations,
    queryFn: ({ signal }) => api.get<IntegrationStatus[]>('/api/integrations', undefined, signal),
    // Poll while any sync is running.
    refetchInterval: (query) => (query.state.data?.some((i) => i.state === 'running') ? 2000 : false),
  });
}

export function useSyncIntegration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: IntegrationName) => api.post<IntegrationStatus>(`/api/integrations/${name}/sync`),
    meta: { silent: true }, // the page handles 409 "already running" itself
    onSuccess: (status) => {
      qc.setQueryData<IntegrationStatus[]>(qk.integrations, (old) =>
        old ? old.map((i) => (i.name === status.name ? status : i)) : [status],
      );
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.integrations }),
  });
}

/** After a sync finishes, data across the app may have changed. */
export function invalidateAfterSync(qc: QueryClient) {
  invalidateInventory(qc);
  void qc.invalidateQueries({ queryKey: ['pullRequests'] });
}

export function usePullRequests(q: PullRequestQueryInput) {
  return useQuery({
    queryKey: qk.pullRequests(q),
    queryFn: ({ signal }) => api.get<PullRequest[]>('/api/pull-requests', q, signal),
    placeholderData: keepPreviousData,
  });
}

// ---------------------------------------------------------------------------
// Bugs
// ---------------------------------------------------------------------------

function invalidateBugs(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ['bugs'] });
  void qc.invalidateQueries({ queryKey: qk.bugStats });
  void qc.invalidateQueries({ queryKey: ['testCases'] });
  void qc.invalidateQueries({ queryKey: ['testCase'] });
  void qc.invalidateQueries({ queryKey: ['runFailures'] });
  void qc.invalidateQueries({ queryKey: qk.summary });
  void qc.invalidateQueries({ queryKey: ['report'] });
}

export function useBugs(q: BugQueryInput, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.bugs(q),
    queryFn: ({ signal }) => api.get<BugList>('/api/bugs', q, signal),
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
  });
}

export function useBugStats() {
  return useQuery({ queryKey: qk.bugStats, queryFn: ({ signal }) => api.get<BugStats>('/api/bugs/stats', undefined, signal) });
}

export function useCreateBug() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: z.input<typeof BugCreate>) => api.post<Bug>('/api/bugs', body),
    onSuccess: () => invalidateBugs(qc),
  });
}

export function useUpdateBug() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: BugUpdate }) => api.patch<Bug>(`/api/bugs/${id}`, patch),
    onSuccess: () => invalidateBugs(qc),
  });
}

export function useDeleteBug() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/api/bugs/${id}`),
    onSuccess: () => invalidateBugs(qc),
  });
}

// ---------------------------------------------------------------------------
// Camel route triggers
// ---------------------------------------------------------------------------

export function useTriggers(q: TriggerQueryInput, enabled = true) {
  return useQuery({
    enabled,
    queryKey: qk.triggers(q),
    queryFn: ({ signal }) => api.get<TriggerListResponse>('/api/triggers', q, signal),
    placeholderData: keepPreviousData,
  });
}

/** The default branch's routes with one status (untested first), for the Overview. */
export function useTriggerOverview(
  status: RouteStatus | undefined,
  limit = 8,
  branch?: string | null,
  folder?: string | null,
  tests?: string | null,
  kinds?: string | null,
  exclude?: string | null,
  preset?: string | null,
) {
  return useQuery({
    queryKey: ['triggers', 'overview', status ?? null, limit, branch ?? null, folder ?? null, tests ?? null, kinds ?? null, exclude ?? null, preset ?? null],
    queryFn: ({ signal }) =>
      api.get<TriggerOverviewResponse>(
        '/api/triggers/overview',
        {
          ...(status ? { status } : {}),
          limit: String(limit),
          ...(branch ? { branch } : {}),
          ...(folder ? { folder } : {}),
          ...(tests ? { tests } : {}),
          ...(kinds ? { kinds } : {}),
          ...(exclude ? { exclude } : {}),
          ...(preset ? { preset } : {}),
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });
}

/** The merged tests that cover no trigger of the routes branch, with the strings the scanner read in each. */
export function useUnlinkedTests(branch: string | null, tests: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['triggers', 'unlinked', branch, tests],
    queryFn: ({ signal }) =>
      api.get<UnlinkedTestsResponse>('/api/triggers/unlinked-tests', { ...(branch ? { branch } : {}), ...(tests ? { tests } : {}) }, signal),
    enabled,
  });
}

/** The "Scan open PRs" job: polled every 1.5 s while it runs. */
export function usePrScan(enabled = true) {
  return useQuery({
    queryKey: ['triggers', 'pr-scan'],
    queryFn: ({ signal }) => api.get<PrScanStatus>('/api/triggers/pr-scan', undefined, signal),
    enabled,
    refetchInterval: (q) => (q.state.data?.state === 'running' ? 1500 : false),
  });
}

export function useStartPrScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<PrScanStatus>('/api/triggers/pr-scan', {}),
    onSuccess: (st) => qc.setQueryData(['triggers', 'pr-scan'], st),
  });
}

export function useDeleteTriggerBranch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (branch: string) => api.delete<void>(`/api/triggers/branches/${encodeURIComponent(branch)}`),
    onSuccess: () => {
      // the branch's tests no longer count towards triggers tested
      void qc.invalidateQueries({ queryKey: ['triggers'] });
      void qc.invalidateQueries({ queryKey: qk.summary });
      void qc.invalidateQueries({ queryKey: ['report'] });
    },
  });
}

export function useTriggerGithub() {
  return useQuery({
    queryKey: ['triggers', 'github'],
    queryFn: ({ signal }) => api.get<TriggerGithubInfo>('/api/triggers/github', undefined, signal),
    staleTime: 60_000,
  });
}

export function useTriggerBranches(repo: string | null) {
  return useQuery({
    queryKey: ['triggers', 'github', 'branches', repo],
    queryFn: ({ signal }) => api.get<{ branches: string[] }>('/api/triggers/github/branches', { repo: repo! }, signal),
    enabled: !!repo,
    staleTime: 60_000,
  });
}

export function useScanGithubBranch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TriggerGithubScanRequest) => api.post<TriggerScanResponse>('/api/triggers/scan-github', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['triggers'] });
      void qc.invalidateQueries({ queryKey: qk.summary });
      void qc.invalidateQueries({ queryKey: ['report'] });
      void qc.invalidateQueries({ queryKey: ['testCases'] });
    },
  });
}

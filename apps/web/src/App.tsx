import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster, toast } from 'sonner';
import { ApiError, errorMessage, setUnauthorizedHandler } from './api/client';
import { qk, useSession } from './api/hooks';
import { useTheme } from './lib/theme';
import { TooltipProvider } from './components/ui/tooltip';
import { ReportLayout, WorkspaceLayout } from './components/Layout';
import { Skeleton } from './components/ui/skeleton';
import { LoginPage } from './pages/Login';
import { NotFoundPage } from './pages/NotFound';

// Every page is its own chunk (Recharts etc. load only with the pages that chart).
const OverviewPage = lazy(() => import('./pages/Overview').then((m) => ({ default: m.OverviewPage })));
const TestCasesPage = lazy(() => import('./pages/TestCases'));
const TestCaseDetailPage = lazy(() => import('./pages/TestCaseDetail'));
const RunsPage = lazy(() => import('./pages/Runs'));
const RunDetailPage = lazy(() => import('./pages/RunDetail'));
const HistoryPage = lazy(() => import('./pages/History'));
const ComparePage = lazy(() => import('./pages/Compare'));
const ImportPage = lazy(() => import('./pages/Import'));
const IntegrationsPage = lazy(() => import('./pages/Integrations'));
const PullRequestsPage = lazy(() => import('./pages/PullRequests'));
const BugsPage = lazy(() => import('./pages/Bugs'));
const ReportPage = lazy(() => import('./pages/Report'));

function makeClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (e, query) => {
        // Background refetch failures of already-loaded data get a toast; first-load errors render inline.
        if (e instanceof ApiError && e.status === 401) return;
        if (query.state.data !== undefined) toast.error(errorMessage(e));
      },
    }),
    mutationCache: new MutationCache({
      onError: (e, _v, _c, mutation) => {
        if (e instanceof ApiError && e.status === 401) return;
        if (mutation.options.meta?.silent) return;
        toast.error(errorMessage(e));
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        retry: (count, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && count < 2,
      },
    },
  });
}

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: { silent?: boolean };
  }
}

function PageFallback() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function FullScreenLoading() {
  return (
    <div className="grid min-h-dvh place-items-center bg-bg" role="status" aria-label="Loading">
      <div className="w-64 space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-full" />
      </div>
    </div>
  );
}

/** Routes 401s to /login without a full reload. */
function UnauthorizedBridge({ client }: { client: QueryClient }) {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (location.pathname.startsWith('/login')) return;
      void client.invalidateQueries({ queryKey: qk.session });
      const next = location.pathname + location.search;
      void navigate(`/login?next=${encodeURIComponent(next)}`, { replace: true });
    });
  }, [navigate, location, client]);
  return null;
}

/** Gate: login when required; viewers are confined to the report. */
function Gate({ children, allowViewer = false }: { children: ReactNode; allowViewer?: boolean }) {
  const session = useSession();
  const location = useLocation();
  if (session.isPending) return <FullScreenLoading />;
  const s = session.data;
  if (s && s.authRequired && !s.authenticated) {
    const next = location.pathname + location.search;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  if (s?.role === 'viewer' && !allowViewer) return <Navigate to="/report" replace />;
  return <>{children}</>;
}

function ThemedToaster() {
  const { resolved } = useTheme();
  return (
    <Toaster
      theme={resolved}
      position="bottom-right"
      closeButton
      toastOptions={{ className: 'text-[13px]' }}
    />
  );
}

export function App() {
  const [client] = useState(makeClient);
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={250}>
        <BrowserRouter>
          <UnauthorizedBridge client={client} />
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/report"
              element={
                <Gate allowViewer>
                  <ReportLayout>
                    <Suspense fallback={<div className="mx-auto max-w-6xl p-6"><PageFallback /></div>}>
                      <ReportPage />
                    </Suspense>
                  </ReportLayout>
                </Gate>
              }
            />
            <Route
              element={
                <Gate>
                  <WorkspaceLayout />
                </Gate>
              }
            >
              <Route index element={<Suspense fallback={<PageFallback />}><OverviewPage /></Suspense>} />
              <Route path="tests" element={<Suspense fallback={<PageFallback />}><TestCasesPage /></Suspense>} />
              <Route path="tests/:id" element={<Suspense fallback={<PageFallback />}><TestCaseDetailPage /></Suspense>} />
              <Route path="pulls" element={<Suspense fallback={<PageFallback />}><PullRequestsPage /></Suspense>} />
              <Route path="bugs" element={<Suspense fallback={<PageFallback />}><BugsPage /></Suspense>} />
              <Route path="runs" element={<Suspense fallback={<PageFallback />}><RunsPage /></Suspense>} />
              <Route path="runs/history" element={<Suspense fallback={<PageFallback />}><HistoryPage /></Suspense>} />
              <Route path="runs/compare" element={<Suspense fallback={<PageFallback />}><ComparePage /></Suspense>} />
              <Route path="runs/:id" element={<Suspense fallback={<PageFallback />}><RunDetailPage /></Suspense>} />
              <Route path="import" element={<Suspense fallback={<PageFallback />}><ImportPage /></Suspense>} />
              <Route path="integrations" element={<Suspense fallback={<PageFallback />}><IntegrationsPage /></Suspense>} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
        <ThemedToaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { KeyRound } from 'lucide-react';
import { useLogin, useSession } from '../api/hooks';
import { errorMessage } from '../api/client';
import { Brand } from '../components/Brand';
import { Button } from '../components/ui/button';
import { Input, Label } from '../components/ui/input';
import { ThemeToggle } from '../components/ThemeToggle';
import { safeNextPath } from '../lib/url';


export function LoginPage() {
  const [params] = useSearchParams();
  const next = safeNextPath(params.get('next'));
  const session = useSession();
  const login = useLogin();
  const navigate = useNavigate();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (session.data && (!session.data.authRequired || session.data.authenticated)) {
    const dest = session.data.role === 'viewer' ? '/report' : next;
    return <Navigate to={dest} replace />;
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    login.mutate(
      { token: token.trim() },
      {
        onSuccess: () => {
          setToken('');
          void navigate(next, { replace: true });
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  return (
    <div className="relative grid min-h-dvh place-items-center bg-bg px-4">
      <div className="absolute top-3 right-3">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Brand />
        </div>
        <form onSubmit={submit} className="rounded-xl border border-border bg-surface p-6 shadow-md" noValidate>
          <h1 className="text-base font-semibold text-fg">Sign in</h1>
          <p className="mt-1 text-[13px] text-fg-2">Enter the dashboard access token provided by your admin.</p>
          <div className="mt-5">
            <Label htmlFor="token">Access token</Label>
            <div className="relative">
              <KeyRound className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
              <Input
                id="token"
                type="password"
                autoComplete="current-password"
                autoFocus
                required
                maxLength={512}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="pl-8"
                aria-invalid={!!error}
                aria-describedby={error ? 'token-error' : undefined}
              />
            </div>
            {error ? (
              <p id="token-error" className="mt-1.5 text-xs text-bad" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <Button type="submit" variant="primary" className="mt-5 w-full" loading={login.isPending} disabled={!token.trim()}>
            Sign in
          </Button>
        </form>
        <p className="mt-4 text-center text-xs text-fg-3">Your session is kept in a secure, httpOnly cookie.</p>
      </div>
    </div>
  );
}

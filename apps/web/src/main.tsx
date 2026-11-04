import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './index.css';
import { App } from './App';

async function boot() {
  // Dev-only fixture layer (never included in production builds: import.meta.env.DEV is statically false there).
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK === '1') {
    const { installMocks } = await import('./mocks/install');
    installMocks();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();

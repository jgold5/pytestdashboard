import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { useMeta } from '../api/hooks';
import { readStorage, writeStorage } from './storage';

const KEY = 'ptd-run-group';
export const ALL_GROUPS = '__all__';

/**
 * Selected run group for the Runs/History area. Source of truth is the `group`
 * URL param (shareable); falls back to the last choice (localStorage) and then
 * to the most recently active group. `allowAll` lets the Runs list show every group.
 */
export function useRunGroupSelection({ allowAll = false }: { allowAll?: boolean } = {}) {
  const meta = useMeta();
  const [params, setParams] = useSearchParams();
  const groups = useMemo(() => meta.data?.runGroups ?? [], [meta.data]);
  const fromUrl = params.get('group');
  const stored = readStorage(KEY);

  const valid = (g: string | null | undefined): g is string =>
    !!g && (g === ALL_GROUPS ? allowAll : groups.some((x) => x.name === g));

  let value: string | null;
  if (valid(fromUrl)) value = fromUrl;
  else if (fromUrl && !meta.data) value = fromUrl; // meta still loading: trust URL
  else if (valid(stored)) value = stored;
  else value = groups[0]?.name ?? (allowAll ? ALL_GROUPS : null);

  const setValue = useCallback(
    (g: string) => {
      writeStorage(KEY, g);
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('group', g);
          next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  return { groups, value, setValue, loading: meta.isPending };
}

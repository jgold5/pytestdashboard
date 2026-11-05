import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useNavigate } from 'react-router';
import type { Summary } from '@ptd/shared';
import { useCssVars } from '../../lib/theme';
import { fmtDate, fmtNumber, fmtPct } from '../../lib/utils';
import { ChartTooltipBox, Legend } from './ChartTooltip';

type RunPoint = Summary['runTrend'][number];
const KEYS = ['passed', 'failed', 'broken', 'skipped'] as const;
const LABEL: Record<(typeof KEYS)[number], string> = {
  passed: 'Passed',
  failed: 'Failed',
  broken: 'Broken',
  skipped: 'Skipped',
};

/** Results per run, stacked by status (status palette), click a bar to open the run. */
export function RunTrendChart({ data, height = 220 }: { data: RunPoint[]; height?: number }) {
  const navigate = useNavigate();
  const c = useCssVars(['st-passed', 'st-failed', 'st-broken', 'st-skipped', 'fg-3', 'grid', 'axis', 'surface', 'surface-2'] as const);
  const color = { passed: c['st-passed'], failed: c['st-failed'], broken: c['st-broken'], skipped: c['st-skipped'] };
  const rows = data.map((r) => ({ ...r, ...r.counts, when: r.startedAt ?? r.importedAt }));
  // Tick formatter's 2nd arg is the *tick* index (ticks are thinned by minTickGap),
  // not the data index — look the date up by run id.
  const whenById = new Map(rows.map((r) => [r.id, r.when]));
  return (
    <div>
      <div className="mb-2">
        <Legend items={KEYS.map((k) => ({ label: LABEL[k], color: color[k] }))} />
      </div>
      <div style={{ height }} role="img" aria-label={`Results of the last ${data.length} runs by status`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -8 }} barCategoryGap="22%" maxBarSize={24}>
            <CartesianGrid vertical={false} stroke={c.grid} />
            <XAxis
              dataKey="id"
              tickFormatter={(v: number) => fmtDate(whenById.get(v), 'MMM d')}
              tick={{ fontSize: 11, fill: c['fg-3'] }}
              tickLine={false}
              axisLine={{ stroke: c.axis }}
              minTickGap={24}
            />
            <YAxis tick={{ fontSize: 11, fill: c['fg-3'] }} tickLine={false} axisLine={false} width={44} allowDecimals={false} tickFormatter={(v: number) => fmtNumber(v)} />
            <Tooltip
              cursor={{ fill: c['surface-2'] }}
              content={({ active, payload }) => {
                const p = active && payload?.[0] ? (payload[0].payload as (typeof rows)[number]) : null;
                if (!p) return null;
                return (
                  <ChartTooltipBox
                    title={
                      <>
                        <span className="text-fg">{p.name}</span> · {fmtDate(p.when, 'MMM d, HH:mm')}
                      </>
                    }
                    rows={KEYS.map((k) => ({ color: color[k], label: LABEL[k], value: fmtNumber(p.counts[k]), shape: 'square' as const }))}
                    footer={<>Pass rate: <b className="text-fg">{fmtPct(p.passRate, 1)}</b></>}
                  />
                );
              }}
            />
            {KEYS.map((k, i) => (
              <Bar
                key={k}
                dataKey={k}
                stackId="s"
                fill={color[k]}
                stroke={c.surface}
                strokeWidth={1}
                radius={i === KEYS.length - 1 ? [3, 3, 0, 0] : 0}
                isAnimationActive={false}
                cursor="pointer"
                onClick={(d: { payload?: { id?: number } }) => {
                  if (d?.payload?.id) void navigate(`/runs/${d.payload.id}`);
                }}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

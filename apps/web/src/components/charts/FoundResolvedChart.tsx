import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useCssVars } from '../../lib/theme';
import { fmtDate } from '../../lib/utils';
import { ChartTooltipBox, Legend } from './ChartTooltip';

export function FoundResolvedChart({ trend, height = 210 }: { trend: { weekStart: string; found: number; resolved: number }[]; height?: number }) {
  const c = useCssVars(['tr-product_bug', 'tr-test_bug', 'fg-3', 'grid', 'axis', 'surface-2'] as const);
  const found = c['tr-product_bug'];
  const resolved = c['tr-test_bug'];
  return (
    <div>
      <div className="mb-2">
        <Legend
          items={[
            { label: 'Found', color: found },
            { label: 'Resolved', color: resolved },
          ]}
        />
      </div>
      <div style={{ height }} role="img" aria-label="Bugs found and resolved per week">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={trend} margin={{ top: 6, right: 6, bottom: 0, left: -16 }} barGap={2} maxBarSize={12}>
            <CartesianGrid vertical={false} stroke={c.grid} />
            <XAxis dataKey="weekStart" tickFormatter={(d: string) => fmtDate(d, 'MMM d')} tick={{ fontSize: 11, fill: c['fg-3'] }} tickLine={false} axisLine={{ stroke: c.axis }} minTickGap={24} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: c['fg-3'] }} tickLine={false} axisLine={false} width={40} />
            <Tooltip
              cursor={{ fill: c['surface-2'] }}
              content={({ active, payload }) => {
                const p = active && payload?.[0] ? (payload[0].payload as (typeof trend)[number]) : null;
                if (!p) return null;
                return (
                  <ChartTooltipBox
                    title={`Week of ${fmtDate(p.weekStart)}`}
                    rows={[
                      { color: found, label: 'Found', value: p.found, shape: 'square' },
                      { color: resolved, label: 'Resolved', value: p.resolved, shape: 'square' },
                    ]}
                  />
                );
              }}
            />
            <Bar dataKey="found" fill={found} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            <Bar dataKey="resolved" fill={resolved} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}


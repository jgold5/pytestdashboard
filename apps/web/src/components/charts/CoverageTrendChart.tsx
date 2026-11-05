import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Summary } from '@ptd/shared';
import { useCssVars } from '../../lib/theme';
import { fmtDate, fmtNumber, fmtPct } from '../../lib/utils';
import { ChartTooltipBox, Legend } from './ChartTooltip';

type Point = Summary['coverageTrend'][number];

/** Total vs automated cases over time (same unit, one axis). */
export function CoverageTrendChart({ data, height = 220 }: { data: Point[]; height?: number }) {
  const c = useCssVars(['au-automated', 'fg-3', 'grid', 'axis', 'surface'] as const);
  return (
    <div>
      <div className="mb-2">
        <Legend
          items={[
            { label: 'Automated', color: c['au-automated'], shape: 'line' },
            { label: 'Total cases', color: c['fg-3'], shape: 'line' },
          ]}
        />
      </div>
      <div style={{ height }} role="img" aria-label={`Coverage trend, ${data.length} days`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid vertical={false} stroke={c.grid} />
            <XAxis
              dataKey="date"
              tickFormatter={(d: string) => fmtDate(d, 'MMM d')}
              tick={{ fontSize: 11, fill: c['fg-3'] }}
              tickLine={false}
              axisLine={{ stroke: c.axis }}
              minTickGap={32}
            />
            <YAxis
              tick={{ fontSize: 11, fill: c['fg-3'] }}
              tickLine={false}
              axisLine={false}
              width={44}
              tickFormatter={(v: number) => fmtNumber(v)}
              allowDecimals={false}
            />
            <Tooltip
              cursor={{ stroke: c.axis, strokeWidth: 1 }}
              content={({ active, payload }) => {
                const p = active && payload?.[0] ? (payload[0].payload as Point) : null;
                if (!p) return null;
                return (
                  <ChartTooltipBox
                    title={fmtDate(p.date)}
                    rows={[
                      { color: c['au-automated'], label: 'Automated', value: fmtNumber(p.automated) },
                      { color: c['fg-3'], label: 'Total cases', value: fmtNumber(p.total) },
                    ]}
                    footer={<>Automation: <b className="text-fg">{fmtPct(p.total ? p.automated / p.total : null, 1)}</b></>}
                  />
                );
              }}
            />
            <Area
              type="monotone"
              dataKey="automated"
              stroke={c['au-automated']}
              strokeWidth={2}
              fill={c['au-automated']}
              fillOpacity={0.1}
              isAnimationActive={false}
              activeDot={{ r: 4, stroke: c.surface, strokeWidth: 2 }}
            />
            <Line
              type="monotone"
              dataKey="total"
              stroke={c['fg-3']}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              activeDot={{ r: 4, stroke: c.surface, strokeWidth: 2 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

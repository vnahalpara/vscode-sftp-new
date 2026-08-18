import React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

// Fixed categorical order — assigned by slot, never cycled. Matches
// --series-1..4 in styles.css.
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500'];

// One shared, low-opacity stroke for charts that draw one line per core.
// Named-colour identity (SERIES[i % SERIES.length]) breaks down past 4
// cores — an 8/16/64-core host would either repeat colours across unrelated
// cores (collided legend, overlapping look-alike lines) or need a legend
// with dozens of entries nobody can use. Per-core detail is not "which core
// is #7", it is "is any core hot" — a fan of translucent lines makes a
// single outlier visually pop out of the pack (higher, and not blended into
// the overlapping band the idle cores form) without asking for that many
// distinct hues or a legend that cannot fit.
export const MUTED_LINE = 'rgba(137, 135, 129, 0.55)';

// Matches the dark theme tokens in styles.css: --text-muted, --grid, --axis,
// --surface-1, --text-secondary.
const INK = { muted: '#898781', grid: '#2c2c2a', axis: '#383835', surface: '#1a1a19', secondary: '#c3c2b7' };

const timeFmt = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function TooltipBox({ active, payload, label, unit, format }) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: INK.surface,
        border: '1px solid rgba(255,255,255,0.14)',
        borderRadius: 8,
        padding: '8px 10px',
        fontSize: 12,
        boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
      }}
    >
      <div style={{ color: INK.muted, marginBottom: 5 }}>
        {new Date(label).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
      </div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ display: 'flex', alignItems: 'center', gap: 7, color: INK.secondary }}>
          <i style={{ width: 9, height: 9, borderRadius: 2, background: p.color, display: 'inline-block' }} />
          <span>{p.name}</span>
          <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', color: '#fff' }}>
            {/* A null point means "not computable", not zero — check it before
                falling through to any formatter that might coerce it. */}
            {p.value == null ? '—' : format ? format(p.value) : `${Number(p.value).toFixed(1)}${unit || ''}`}
          </span>
        </div>
      ))}
    </div>
  );
}

function Legend({ series }) {
  if (series.length < 2) return null;
  return (
    <div className="legend">
      {series.map((s, i) => (
        <span key={s.key}>
          <i style={{ background: s.color || SERIES[i] }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

// The window shown for the placeholder frame before any sample has arrived —
// matches the shortest range in series.ts's RANGES.
const EMPTY_WINDOW_MS = 5 * 60 * 1000;

// Recharts silently drops XAxis/YAxis entirely (not just the line — the
// whole axis) when it cannot compute a numeric domain from `data`, which
// happens both for a genuinely empty array and for a non-empty array whose
// series keys are all null (e.g. a device that just appeared). Two bare `at`
// points give the time axis something to lay ticks across; the y-domain
// falls back to a fixed range for the same reason.
function hasPlottableValue(points, series) {
  return points.some((p) => series.some((s) => typeof p[s.key] === 'number'));
}

// The y-domain to use while nothing is plottable. [0,'auto'] can't be
// resolved without a numeric column (see above), so a finite domain is
// required just to keep the axis structurally present — but the domain's
// actual numbers must not be shown as if they meant something. '%' is the
// one unit whose true range genuinely is [0,100], so that placeholder scale
// is honest and its labels stay visible. Every other unit (bytes/sec, etc.)
// has no fixed range: [0,1] here is an arbitrary finite pair chosen only to
// satisfy recharts, and `tick: false` hides its labels so no invented number
// (e.g. "20 B/s" on an idle network chart) is ever drawn.
function fallbackYAxis(unit) {
  return unit === '%' ? { domain: [0, 100], tick: true } : { domain: [0, 1], tick: false };
}

/**
 * Shared frame for the area/line variants below. One y-axis, always — two
 * measures of different scale belong in two charts.
 *
 * `data` may be an empty array: this is the normal state before the first
 * tick arrives, so the axis and grid still render rather than bailing out to
 * a placeholder box.
 */
function SeriesChart({ data, series, height, unit, format, area, legend = true }) {
  const raw = data || [];
  const plottable = hasPlottableValue(raw, series);
  const now = Date.now();
  // Key-less on purpose: the placeholder frame has nothing to plot, so it
  // omits every series key entirely rather than setting them to `null`.
  // Recharts treats a missing key the same as an explicit `null` for both
  // `connectNulls` and the tooltip's `p.value == null` check, so this reads
  // identically to "no data" without a real series key ever needing to
  // carry a value that doesn't exist.
  const points = raw.length && plottable ? raw : [{ at: now - EMPTY_WINDOW_MS }, { at: now }];
  const fallback = fallbackYAxis(unit);
  const Chart = area ? AreaChart : LineChart;
  return (
    <>
      <ResponsiveContainer width="100%" height={height}>
        <Chart data={points} margin={{ top: 6, right: 8, bottom: 0, left: -14 }}>
          <defs>
            {area &&
              series.map((s, i) => (
                <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color || SERIES[i]} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={s.color || SERIES[i]} stopOpacity={0.02} />
                </linearGradient>
              ))}
          </defs>
          <CartesianGrid stroke={INK.grid} strokeDasharray="0" vertical={false} />
          <XAxis
            dataKey="at"
            tickFormatter={timeFmt}
            stroke={INK.axis}
            tick={{ fill: INK.muted, fontSize: 11 }}
            tickLine={false}
            minTickGap={44}
          />
          <YAxis
            domain={plottable ? [0, 'auto'] : fallback.domain}
            stroke={INK.axis}
            tick={plottable || fallback.tick ? { fill: INK.muted, fontSize: 11 } : false}
            tickLine={false}
            axisLine={false}
            // 54 was sized for short labels ("100%", "0.75") and, combined
            // with the chart's negative left margin below, clipped the
            // leading digit of longer formatted values (fmtRate's
            // "214.8 KB/s" and friends) — confirmed by measuring the
            // rendered tick <text> bboxes, which went negative-x at 54/64.
            // 90 keeps every observed fmtRate/fmtBytes-style label's bbox
            // safely inside the SVG at 0 for a positive x, with room to
            // spare for the widest realistic case ("1023.9 PB/s"), while
            // adding only a small, non-breaking gutter to the short percent/
            // load labels.
            width={90}
            // Same fallback order as TooltipBox: a caller-supplied formatter
            // (fmtRate, fmtLoad, ...) always wins. Without this, a chart
            // whose caller passes `format` but no `unit` (network throughput
            // is exactly this) rendered bare, unscaled numbers on the axis
            // while the tooltip correctly showed a formatted rate.
            tickFormatter={(v) => (format ? format(v) : `${v}${unit}`)}
          />
          <Tooltip
            content={<TooltipBox unit={unit} format={format} />}
            cursor={{ stroke: INK.muted, strokeWidth: 1, strokeDasharray: '3 3' }}
          />
          {series.map((s, i) =>
            area ? (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color || SERIES[i]}
                fill={`url(#grad-${s.key})`}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                // A null rate/reading means the value wasn't computable — a
                // first tick, a counter reset — not that it dropped to zero.
                // Bridging the gap here would draw that lie into the chart.
                connectNulls={false}
              />
            ) : (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color || SERIES[i]}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
            )
          )}
        </Chart>
      </ResponsiveContainer>
      {legend && <Legend series={series} />}
    </>
  );
}

/** Filled area chart. `series` is `[{ key, label, color? }]`; `data` is `SeriesPoint[]` from series.ts. */
export function AreaSeries({ data, series, unit = '', format, height = 190, legend = true }) {
  return <SeriesChart data={data} series={series} height={height} unit={unit} format={format} area legend={legend} />;
}

/** Plain line chart. Same props as `AreaSeries`. */
export function LineSeries({ data, series, unit = '', format, height = 190, legend = true }) {
  return (
    <SeriesChart data={data} series={series} height={height} unit={unit} format={format} area={false} legend={legend} />
  );
}

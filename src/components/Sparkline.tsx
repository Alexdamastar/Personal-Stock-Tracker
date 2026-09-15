import type { DashboardRow } from '../lib/dashboard-types.js';
import { formatMoney } from './format.js';

type SparklineData = DashboardRow['sparkline'];

const WIDTH = 120;
const HEIGHT = 36;
/** Keeps the stroke and a rule sitting exactly on min/max from being clipped. */
const PAD = 3;

export interface SparklineGeometry {
  /** SVG polyline `points`, or null with fewer than two closes. */
  line: string | null;
  /** The lone point when there is exactly one close. */
  dot: { x: number; y: number } | null;
  safeY: number | null;
  buyY: number | null;
}

/**
 * Pure geometry, exported for tests. The y-domain spans the closes AND both rules:
 * a buy price far below the last 30 days (AAPL's $121 against a ~$230 price) is the
 * normal case, and a rule clipped off the chart would hide exactly what the chart is for.
 */
export function sparklineGeometry(data: SparklineData, width = WIDTH, height = HEIGHT): SparklineGeometry {
  const values = data.points.map((p) => p.close);
  if (data.safe !== null) values.push(data.safe);
  if (data.buy !== null) values.push(data.buy);

  if (values.length === 0) return { line: null, dot: null, safeY: null, buyY: null };

  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi === lo) {
    // A flat series has no range to scale; centre it instead of dividing by zero.
    const half = Math.abs(hi) * 0.01 || 1;
    lo -= half;
    hi += half;
  }

  const y = (v: number) => PAD + ((hi - v) / (hi - lo)) * (height - 2 * PAD);
  const n = data.points.length;
  const x = (i: number) => (n === 1 ? width / 2 : PAD + (i / (n - 1)) * (width - 2 * PAD));
  const round = (v: number) => Math.round(v * 100) / 100;

  const line =
    n >= 2 ? data.points.map((p, i) => `${round(x(i))},${round(y(p.close))}`).join(' ') : null;
  const first = data.points[0];
  const dot = n === 1 && first ? { x: round(x(0)), y: round(y(first.close)) } : null;

  return {
    line,
    dot,
    safeY: data.safe === null ? null : round(y(data.safe)),
    buyY: data.buy === null ? null : round(y(data.buy)),
  };
}

function describe(data: SparklineData): string {
  const first = data.points[0];
  const last = data.points[data.points.length - 1];
  const parts: string[] = [];
  if (!first || !last) return 'No price history';
  if (first === last) parts.push(`One close: ${formatMoney(last.close)}`);
  else parts.push(`${data.points.length} daily closes, ${formatMoney(first.close)} to ${formatMoney(last.close)}`);
  if (data.safe !== null) parts.push(`safe price ${formatMoney(data.safe)}`);
  if (data.buy !== null) parts.push(`buy price ${formatMoney(data.buy)}`);
  return parts.join('; ');
}

/**
 * 30-day close sparkline with the safe and buy prices as horizontal rules. Hand-rolled
 * SVG: one polyline does not justify a chart library in the bundle.
 *
 * The two rules differ by dash pattern as well as color (safe dashed, buy solid), and
 * use the same status colors as the chips, so a line on the chart and the chip it
 * produces read as one thing.
 */
export function Sparkline({ data }: { data: SparklineData }) {
  // Rules with no closes to compare against would be a chart of nothing.
  if (data.points.length === 0) {
    return <span className="text-caption text-muted">no history</span>;
  }

  const g = sparklineGeometry(data);
  const label = describe(data);

  return (
    <svg
      role="img"
      aria-label={label}
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="block overflow-visible"
      data-testid="sparkline"
    >
      <title>{label}</title>
      {g.safeY !== null && (
        <line
          data-rule="safe"
          x1={0}
          x2={WIDTH}
          y1={g.safeY}
          y2={g.safeY}
          className="stroke-status-safe"
          strokeWidth={1.5}
          strokeDasharray="4 2.5"
        />
      )}
      {g.buyY !== null && (
        <line
          data-rule="buy"
          x1={0}
          x2={WIDTH}
          y1={g.buyY}
          y2={g.buyY}
          className="stroke-status-buy"
          strokeWidth={1.5}
        />
      )}
      {g.line !== null && (
        <polyline
          points={g.line}
          fill="none"
          className="stroke-ink"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      {g.dot !== null && <circle cx={g.dot.x} cy={g.dot.y} r={2.5} className="fill-ink" />}
    </svg>
  );
}

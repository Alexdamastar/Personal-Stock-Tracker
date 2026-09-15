import type { DashboardRow, Distance, ValuationMethod } from '../lib/dashboard-types.js';
import type { ReactNode } from 'react';
import {
  EMPTY,
  formatAlertTime,
  formatMoney,
  formatPbtYears,
  formatQuoteAge,
  formatSignedMoney,
  formatSignedPct,
  sideOf,
} from './format.js';
import { Sparkline } from './Sparkline.js';
import { StateChip } from './StateChip.js';

/**
 * §5 M5 — the watchlist table. Presentational: DashboardRow[] in, HTML out, no data
 * fetching and no client state, so it renders on the server and in a test alike.
 *
 * Rows arrive sorted by the view model (DEFECT-10 sortKey). Never re-sort here: a
 * second ordering rule in the UI would silently disagree with the tested one.
 *
 * Styled as DESIGN.md's data table: a flat white card with a hairline edge and 12px
 * radius on the warm canvas; a canvas-soft header band in uppercase eyebrow type;
 * body-sm rows on a 12px pad, divided by hairlines.
 */
// 12px/16px is DESIGN.md's cell padding; at 10 columns 16px horizontal pushed the
// last column off-screen, so the horizontal step drops to spacing.sm (12px).
const HEAD = 'px-3 py-3';
const CELL = 'px-3 py-3';

export function DashboardTable({ rows }: { rows: DashboardRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full border-collapse text-body-sm">
        <caption className="sr-only">
          Watchlist, sorted by distance to the nearest price line, closest first
        </caption>
        <thead>
          <tr className="border-b border-line bg-canvas text-left text-eyebrow font-semibold uppercase text-muted">
            <th scope="col" className={HEAD}>Ticker</th>
            <th scope="col" className={`${HEAD} text-right`}>Price</th>
            <th scope="col" className={HEAD}>State</th>
            <th scope="col" className={HEAD}>Open alert</th>
            <th scope="col" className={`${HEAD} text-right`}>To safe</th>
            <th scope="col" className={`${HEAD} text-right`}>To buy</th>
            <th scope="col" className={`${HEAD} text-right`}>PBT at price</th>
            <th scope="col" className={`${HEAD} text-right`}>Avg cost</th>
            <th scope="col" className={HEAD}>30 days</th>
            <th scope="col" className={HEAD}>Valuations</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={10} className="px-4 py-8 text-center text-body-md text-muted">
                No active securities.
              </td>
            </tr>
          ) : (
            rows.map((row) => <Row key={row.securityId} row={row} />)
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * No per-state row tint. DESIGN.md forbids its decorative palette as a structural
 * fill, so the chip alone carries a row's state and its emphasis (decision 2026-09-13).
 */
function Row({ row }: { row: DashboardRow }) {
  return (
    <tr
      data-testid="dashboard-row"
      data-ticker={row.ticker}
      className="border-b border-line align-top last:border-b-0"
    >
      <th scope="row" className={`${CELL} text-left font-normal`}>
        <div className="font-semibold text-ink">{row.ticker}</div>
        <div className="text-caption text-muted">{row.name}</div>
      </th>

      <td className={`${CELL} text-right tabular-nums`}>
        <PriceCell row={row} />
      </td>

      <td className={CELL}>
        <StateChip state={row.chip} />
      </td>

      <td className={CELL}>
        <OpenAlerts alerts={row.openAlerts} />
      </td>

      <td className={`${CELL} text-right tabular-nums`}>
        {row.safe === null ? (
          <Muted title="No safe price set">{EMPTY}</Muted>
        ) : (
          <DistanceCell label="safe" threshold={row.safe.threshold} distance={row.safe.distance} />
        )}
      </td>

      <td className={`${CELL} text-right tabular-nums`}>
        {row.buy === null ? (
          <Muted title="No buy rule">{EMPTY}</Muted>
        ) : row.buy.threshold === null ? (
          // D1: an unpinned buy rule with no PBT valuation has no line yet. Say so,
          // rather than a bare dash that reads like missing data.
          <Muted>no PBT valuation yet</Muted>
        ) : (
          <DistanceCell
            label="buy"
            threshold={row.buy.threshold}
            distance={row.buy.distance}
            pinned={row.buy.pinned}
          />
        )}
      </td>

      <td className={`${CELL} whitespace-nowrap text-right tabular-nums`}>
        {row.pbtYearsAtPrice === null ? <Muted>{EMPTY}</Muted> : formatPbtYears(row.pbtYearsAtPrice)}
      </td>

      <td className={`${CELL} text-right tabular-nums`}>
        {row.avgCost === null ? <Muted>{EMPTY}</Muted> : formatMoney(row.avgCost)}
      </td>

      <td className={CELL}>
        <Sparkline data={row.sparkline} />
      </td>

      <td className={CELL}>
        <Secondary ticker={row.ticker} secondary={row.secondary} />
      </td>
    </tr>
  );
}

function Muted({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="text-muted" title={title}>
      {children}
    </span>
  );
}

function PriceCell({ row }: { row: DashboardRow }) {
  if (row.price === null) {
    return (
      <>
        <div className="text-muted">{EMPTY}</div>
        {row.stale && <StaleBadge />}
      </>
    );
  }
  // % change is deliberately uncolored: on this dashboard a falling price is the
  // interesting direction, so market red/green would contradict the state chip.
  const arrow = row.changePct === null ? '' : row.changePct > 0 ? '▲ ' : row.changePct < 0 ? '▼ ' : '';
  return (
    <>
      <div className="text-body-md font-semibold text-ink">{formatMoney(row.price)}</div>
      <div className="text-caption text-ink-secondary" data-testid="change">
        {row.changePct === null ? (
          <Muted title="No previous close">{EMPTY}</Muted>
        ) : (
          <>
            <span aria-hidden="true">{arrow}</span>
            {formatSignedPct(row.changePct)}
          </>
        )}
      </div>
      <div className="whitespace-nowrap text-caption text-muted" data-testid="quote-age">
        {formatQuoteAge(row.quoteAgeMs)}
      </div>
      {row.stale && <StaleBadge />}
    </>
  );
}

/**
 * DESIGN.md has no red. Staleness uses its orange family (decision 2026-09-13): the
 * badge is a tinted status pill with deep-orange text, and its clock glyph gives it a
 * different shape from the approaching chip's orange triangle.
 */
function StaleBadge() {
  return (
    <span
      data-testid="stale-badge"
      title="No successful poll in the last 15 minutes while the market is open"
      className="mt-1 inline-flex items-center gap-1 rounded-sm border border-status-stale bg-status-stale-tint px-1.5 py-px text-eyebrow font-semibold text-status-stale-ink"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false" className="text-status-stale">
        <circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M5 2.6V5l1.6 1.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      stale
    </span>
  );
}

/**
 * Distance to one line, as % and $. The words "below"/"above" carry the direction so
 * a leading minus sign is never the only cue that price has crossed under the line.
 */
function DistanceCell({
  label,
  threshold,
  distance,
  pinned,
}: {
  label: 'safe' | 'buy';
  threshold: number;
  distance: Distance | null;
  pinned?: boolean;
}) {
  const side = distance === null ? null : sideOf(distance.dollars);
  return (
    <div data-testid={`distance-${label}`}>
      {distance === null || side === null ? (
        <div className="text-muted">{EMPTY}</div>
      ) : (
        <>
          {/* Weight, not color, marks a crossed line: DESIGN.md keeps text in ink. */}
          <div className={side === 'above' ? 'text-ink' : 'font-semibold text-ink'}>
            {side === 'at' ? 'at line' : `${formatSignedPct(distance.pct)} ${side}`}
          </div>
          <div className="text-caption text-muted">{formatSignedMoney(distance.dollars)}</div>
        </>
      )}
      <div className="whitespace-nowrap text-caption text-muted">
        {label} {formatMoney(threshold)}
        {pinned && (
          <span className="ml-1 rounded-xs border border-line px-1 text-[11px] font-semibold uppercase" title="Pinned buy price">
            pinned
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The hysteresis state (an alert that fired and has not cleared). Kept in its own
 * column and styled unlike any chip: the chip is price NOW, this is history, and the
 * two can legitimately disagree.
 */
function OpenAlerts({ alerts }: { alerts: DashboardRow['openAlerts'] }) {
  if (alerts.length === 0) return <Muted>{EMPTY}</Muted>;
  return (
    <ul className="space-y-1">
      {alerts.map((a) => (
        <li
          key={a.kind}
          data-testid="open-alert"
          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border border-dashed border-muted bg-surface px-2 py-1 text-eyebrow text-ink-secondary"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false" className="shrink-0 text-muted">
            <path
              d="M3 8.5V5.25a3 3 0 0 1 6 0V8.5l1 1H2zM5 10.75h2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </svg>
          <span>
            {a.kind} alert open at {formatMoney(a.threshold)}
            <span className="block text-[11px] text-muted">since {formatAlertTime(a.triggeredAt)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

const METHODS: { key: ValuationMethod; label: string }[] = [
  { key: 'pbt', label: 'PBT' },
  { key: 'mos', label: 'MOS' },
  { key: 'ten_cap', label: '10 Cap' },
];

/**
 * D2 + §7.2: all three methods side by side, so the PBT headline is never taken for a
 * consensus. Sticker is shown and never used as a line (D2).
 */
function Secondary({ ticker, secondary }: { ticker: string; secondary: DashboardRow['secondary'] }) {
  return (
    <details className="group text-caption" data-testid="secondary">
      {/* A link-like control, so it gets the one structural accent (DESIGN.md). */}
      <summary className="cursor-pointer select-none whitespace-nowrap font-medium text-primary underline-offset-2 hover:underline active:text-primary-active">
        All methods<span className="sr-only"> for {ticker}</span>
      </summary>
      <table className="mt-2 tabular-nums">
        <thead>
          <tr className="text-eyebrow uppercase text-muted">
            <th scope="col" className="pr-3 text-left font-medium">Method</th>
            <th scope="col" className="pr-3 text-right font-medium">Buy</th>
            <th scope="col" className="text-right font-medium">Sticker</th>
          </tr>
        </thead>
        <tbody>
          {METHODS.map(({ key, label }) => {
            const v = secondary[key];
            return (
              <tr key={key} data-method={key}>
                <th scope="row" className="pr-3 text-left font-normal">{label}</th>
                <td className="pr-3 text-right">{v === null ? EMPTY : formatMoney(v.price)}</td>
                <td className="text-right text-muted">{v === null ? EMPTY : formatMoney(v.sticker)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}

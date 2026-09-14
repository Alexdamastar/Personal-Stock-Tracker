import type { ChipState, DashboardRow, Distance, ValuationMethod } from '../lib/dashboard-types.js';
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
 */
export function DashboardTable({ rows }: { rows: DashboardRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          Watchlist, sorted by distance to the nearest price line, closest first
        </caption>
        <thead>
          <tr className="border-b border-line text-left text-xs font-medium uppercase tracking-wide text-muted">
            <th scope="col" className="px-3 py-2">Ticker</th>
            <th scope="col" className="px-3 py-2 text-right">Price</th>
            <th scope="col" className="px-3 py-2">State</th>
            <th scope="col" className="px-3 py-2">Open alert</th>
            <th scope="col" className="px-3 py-2 text-right">To safe</th>
            <th scope="col" className="px-3 py-2 text-right">To buy</th>
            <th scope="col" className="px-3 py-2 text-right">PBT at price</th>
            <th scope="col" className="px-3 py-2 text-right">Avg cost</th>
            <th scope="col" className="px-3 py-2">30 days</th>
            <th scope="col" className="px-3 py-2">Valuations</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={10} className="px-3 py-6 text-center text-muted">
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

/** Row emphasis mirrors the chip hierarchy: at_buy strongest, at_safe next. */
const ROW_CLASSES: Record<ChipState, string> = {
  watching: 'border-l-4 border-l-transparent',
  approaching: 'border-l-4 border-l-transparent',
  at_safe: 'border-l-4 border-l-good bg-good-tint/40',
  at_buy: 'border-l-4 border-l-good-solid bg-good-tint/80',
};

function Row({ row }: { row: DashboardRow }) {
  return (
    <tr
      data-testid="dashboard-row"
      data-ticker={row.ticker}
      className={`border-b border-line align-top last:border-b-0 ${ROW_CLASSES[row.chip]}`}
    >
      <th scope="row" className="px-3 py-2.5 text-left font-normal">
        <div className="font-semibold tracking-wide text-ink">{row.ticker}</div>
        <div className="text-xs text-muted">{row.name}</div>
      </th>

      <td className="px-3 py-2.5 text-right tabular-nums">
        <PriceCell row={row} />
      </td>

      <td className="px-3 py-2.5">
        <StateChip state={row.chip} />
      </td>

      <td className="px-3 py-2.5">
        <OpenAlerts alerts={row.openAlerts} />
      </td>

      <td className="px-3 py-2.5 text-right tabular-nums">
        {row.safe === null ? (
          <Muted title="No safe price set">{EMPTY}</Muted>
        ) : (
          <DistanceCell label="safe" threshold={row.safe.threshold} distance={row.safe.distance} />
        )}
      </td>

      <td className="px-3 py-2.5 text-right tabular-nums">
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

      <td className="px-3 py-2.5 text-right tabular-nums">
        {row.pbtYearsAtPrice === null ? <Muted>{EMPTY}</Muted> : formatPbtYears(row.pbtYearsAtPrice)}
      </td>

      <td className="px-3 py-2.5 text-right tabular-nums">
        {row.avgCost === null ? <Muted>{EMPTY}</Muted> : formatMoney(row.avgCost)}
      </td>

      <td className="px-3 py-2.5">
        <Sparkline data={row.sparkline} />
      </td>

      <td className="px-3 py-2.5">
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
      <div className="text-base font-semibold text-ink">{formatMoney(row.price)}</div>
      <div className="text-xs text-ink" data-testid="change">
        {row.changePct === null ? (
          <Muted title="No previous close">{EMPTY}</Muted>
        ) : (
          <>
            <span aria-hidden="true">{arrow}</span>
            {formatSignedPct(row.changePct)}
          </>
        )}
      </div>
      <div className="whitespace-nowrap text-xs text-muted" data-testid="quote-age">
        {formatQuoteAge(row.quoteAgeMs)}
      </div>
      {row.stale && <StaleBadge />}
    </>
  );
}

function StaleBadge() {
  return (
    <span
      data-testid="stale-badge"
      title="No successful poll in the last 15 minutes while the market is open"
      className="mt-1 inline-flex items-center gap-1 rounded border border-critical bg-critical-tint px-1.5 py-px text-xs font-semibold text-critical-ink"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
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
          <div className={side === 'above' ? 'text-ink' : 'font-semibold text-good-ink'}>
            {side === 'at' ? 'at line' : `${formatSignedPct(distance.pct)} ${side}`}
          </div>
          <div className="text-xs text-muted">{formatSignedMoney(distance.dollars)}</div>
        </>
      )}
      <div className="whitespace-nowrap text-xs text-muted">
        {label} {formatMoney(threshold)}
        {pinned && (
          <span className="ml-1 rounded border border-line px-1 text-[0.65rem] uppercase" title="Pinned buy price">
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
          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded border border-dashed border-ink px-1.5 py-0.5 text-xs text-ink"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
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
            <span className="block text-[0.7rem] text-muted">since {formatAlertTime(a.triggeredAt)}</span>
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
    <details className="group text-xs" data-testid="secondary">
      <summary className="cursor-pointer select-none whitespace-nowrap text-accent underline-offset-2 hover:underline">
        All methods<span className="sr-only"> for {ticker}</span>
      </summary>
      <table className="mt-1.5 tabular-nums">
        <thead>
          <tr className="text-muted">
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

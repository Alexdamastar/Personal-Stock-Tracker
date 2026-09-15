import { AutoRefresh } from '../components/AutoRefresh.js';
import { DashboardTable } from '../components/DashboardTable.js';
import { DemoBanner } from '../components/DemoBanner.js';
import { getAppDb } from '../db/app-db.js';
import { loadDashboardData } from '../db/dashboard-data.js';
import { refreshDemo } from '../db/demo.js';
import { buildDashboardRows } from '../lib/dashboard.js';
import { isStale } from '../lib/market-hours.js';

// Prices are live, so never prerender. This also keeps `next build` from opening a
// database (or booting the PGlite demo) while it collects static pages.
export const dynamic = 'force-dynamic';

const renderedAt = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  timeZone: 'America/New_York',
  timeZoneName: 'short',
});

export default async function DashboardPage() {
  // One `now` for the whole render, so every row's staleness and quote age agree.
  const now = new Date();
  const { db, mode } = await getAppDb();
  // Demo only: re-stamp the invented ticks so an open demo tab never goes stale. This
  // makes no provider call. In database mode page loads only read, and the M3 poller
  // is the sole caller of Finnhub / Twelve Data, so traffic cannot spend API budget.
  if (mode === 'demo') await refreshDemo(db, now);
  const data = await loadDashboardData(db);
  const rows = buildDashboardRows(data, now, { isStale });

  return (
    <>
      {mode === 'demo' && <DemoBanner />}
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        {/* DESIGN.md heading-2: weight 700 with its negative tracking applied explicitly.
            All ink: blue is reserved for actions and links, never a wordmark. */}
        <header className="mb-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-heading-2 font-bold text-ink">Rule #1 Watchlist</h1>
          <p className="text-caption text-muted">
            Updated <time dateTime={now.toISOString()}>{renderedAt.format(now)}</time> · refreshes every
            minute · quotes delayed 15–20 min
          </p>
        </header>
        <DashboardTable rows={rows} />
      </main>
      <AutoRefresh />
    </>
  );
}

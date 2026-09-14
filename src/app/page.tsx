import { AutoRefresh } from '../components/AutoRefresh.js';
import { DashboardTable } from '../components/DashboardTable.js';
import { DemoBanner } from '../components/DemoBanner.js';
import { getAppDb } from '../db/app-db.js';
import { loadDashboardData } from '../db/dashboard-data.js';
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
  const { db, mode } = await getAppDb();
  const data = await loadDashboardData(db);
  // One `now` for the whole render, so every row's staleness and quote age agree.
  const now = new Date();
  const rows = buildDashboardRows(data, now, { isStale });

  return (
    <>
      {mode === 'demo' && <DemoBanner />}
      <main className="mx-auto max-w-7xl px-4 py-6">
        <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xl font-semibold tracking-tight">
            <span className="text-accent">Rule #1</span> Watchlist
          </h1>
          <p className="text-xs text-muted">
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

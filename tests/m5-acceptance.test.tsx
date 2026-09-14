import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { renderToStaticMarkup } from 'react-dom/server';
import { freshDb, schema } from './harness.js';
import { seed } from '../src/db/seed.js';
import { loadDashboardData } from '../src/db/dashboard-data.js';
import { closeAppDb, getAppDb } from '../src/db/app-db.js';
import { refreshDemo } from '../src/db/demo.js';
import { buildDashboardRows } from '../src/lib/dashboard.js';
import { isStale } from '../src/lib/market-hours.js';
import { DashboardTable } from '../src/components/DashboardTable.js';

/**
 * §5 M5 acceptance, END TO END: database -> loader -> view model -> rendered HTML.
 *
 * Each layer was built by a different agent against the shared contract in
 * src/lib/dashboard-types.ts, and each one's own tests ran against STUBS of the
 * others. This is the first place they meet, so it is the test that proves the
 * contract actually held. It renders with react-dom/server, which is how the page is
 * produced in production (a server component), rather than in jsdom.
 */

/** Tickers in rendered row order, read from the HTML rather than from the rows array. */
const renderedOrder = (html: string) => [...html.matchAll(/data-ticker="([A-Z]+)"/g)].map((m) => m[1]);
/** The HTML of the Nth rendered dashboard row. */
const renderedRow = (html: string, n: number) => html.split('data-testid="dashboard-row"')[n + 1] ?? '';

describe('M5 acceptance — seeded database to rendered dashboard', () => {
  it('with seeded data and a fabricated tick at 195.00 for AAPL, the AAPL row renders "at safe price" and sorts first', async () => {
    const { db, close } = await freshDb();
    try {
      await seed(db);
      // Tuesday 11:00 ET, mid-session: the real calendar is in play, not a fake.
      const now = new Date('2026-09-15T15:00:00Z');
      const [aapl] = await db.select().from(schema.securities).where(eq(schema.securities.ticker, 'AAPL'));
      await db.insert(schema.priceTicks).values({
        securityId: aapl!.id, price: 195.0, provider: 'test',
        capturedAt: new Date(now.getTime() - 60_000), quoteAt: new Date(now.getTime() - 20 * 60_000),
      });

      const rows = buildDashboardRows(await loadDashboardData(db), now, { isStale });
      const html = renderToStaticMarkup(<DashboardTable rows={rows} />);

      const order = renderedOrder(html);
      expect(order).toHaveLength(5);
      expect(order[0]).toBe('AAPL');

      const first = renderedRow(html, 0);
      expect(first).toContain('at safe price');
      expect(first).not.toContain('at buy price');
      // A fresh poll mid-session: no stale badge.
      expect(first).not.toContain('data-testid="stale-badge"');
    } finally {
      await close();
    }
  });
});

describe('M5 — the page pipeline in demo mode', () => {
  const saved = process.env.DATABASE_URL;
  afterEach(async () => {
    await closeAppDb();
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  });

  it('boots the demo and renders every chip state, exactly as page.tsx wires it', async () => {
    delete process.env.DATABASE_URL;
    const now = new Date('2026-09-15T15:00:00Z');

    // The same sequence as src/app/page.tsx.
    const { db, mode } = await getAppDb();
    expect(mode).toBe('demo');
    await refreshDemo(db, now);
    const rows = buildDashboardRows(await loadDashboardData(db), now, { isStale });
    const html = renderToStaticMarkup(<DashboardTable rows={rows} />);

    for (const label of ['at buy price', 'at safe price', 'approaching', 'watching']) {
      expect(html, label).toContain(label);
    }
    expect(html).toContain('data-testid="open-alert"');
    expect(html).not.toContain('data-testid="stale-badge"');
    // DEFECT-10 sorts by distance, not by chip. AMZN at 204.10 is 7.2% below its safe
    // 220, further below a line than AAPL's 2.6% under 200, so it comes first.
    expect(renderedOrder(html)[0]).toBe('AMZN');
  });
});

// @vitest-environment jsdom
/**
 * §5 M5 — dashboard UI. Renders hand-built DashboardRow fixtures; no database, no view
 * model. The end-to-end path (seeded DB -> loader -> rows -> table) is a separate
 * integration test, because the UI must be correct for any row the contract allows.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChipState, DashboardRow } from '../src/lib/dashboard-types.js';
import { AutoRefresh } from '../src/components/AutoRefresh.js';
import { DashboardTable } from '../src/components/DashboardTable.js';
import { DemoBanner } from '../src/components/DemoBanner.js';
import { sparklineGeometry } from '../src/components/Sparkline.js';
import { formatQuoteAge, formatSignedPct } from '../src/components/format.js';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  refresh.mockReset();
  vi.useRealTimers();
});

let nextId = 1;

/** A fully-populated AAPL-like row; each test overrides only what it is about. */
function makeRow(overrides: Partial<DashboardRow> = {}): DashboardRow {
  return {
    securityId: nextId++,
    ticker: 'AAPL',
    name: 'Apple Inc.',
    price: 195.5,
    changePct: -0.0123,
    safe: { threshold: 200, distance: { dollars: -4.5, pct: -0.0225 } },
    buy: { threshold: 121.04, pinned: false, distance: { dollars: 74.46, pct: 0.6152 } },
    pbtYearsAtPrice: 9.4,
    avgCost: 228.21,
    chip: 'at_safe',
    openAlerts: [],
    stale: false,
    quoteAgeMs: 20 * 60_000,
    sparkline: {
      points: [
        { date: '2026-09-10', close: 201 },
        { date: '2026-09-11', close: 198 },
        { date: '2026-09-12', close: 195.5 },
      ],
      safe: 200,
      buy: 121.04,
    },
    secondary: {
      pbt: { price: 121.04, sticker: 242.08 },
      mos: { price: 150.25, sticker: 300.5 },
      ten_cap: { price: 98.1, sticker: 196.2 },
    },
    sortKey: -0.0225,
    ...overrides,
  };
}

const rowFor = (ticker: string) =>
  screen.getAllByTestId('dashboard-row').find((tr) => tr.getAttribute('data-ticker') === ticker)!;

describe('DashboardTable', () => {
  it('renders rows in the order given, never re-sorting', () => {
    // Deliberately NOT in sortKey or ticker order: the view model owns ordering.
    const rows = [
      makeRow({ ticker: 'MSFT', sortKey: 0.3, chip: 'watching' }),
      makeRow({ ticker: 'AAPL', sortKey: -0.02 }),
      makeRow({ ticker: 'META', sortKey: null, chip: 'watching' }),
      makeRow({ ticker: 'AMZN', sortKey: 0.01, chip: 'approaching' }),
    ];
    render(<DashboardTable rows={rows} />);
    const order = screen.getAllByTestId('dashboard-row').map((tr) => tr.getAttribute('data-ticker'));
    expect(order).toEqual(['MSFT', 'AAPL', 'META', 'AMZN']);
    // The ticker is the row header, so screen readers announce it per cell.
    const headers = screen.getAllByTestId('dashboard-row').map((tr) => tr.querySelector(':scope > th'));
    expect(headers.map((th) => th?.getAttribute('scope'))).toEqual(['row', 'row', 'row', 'row']);
    expect(headers.map((th) => th?.textContent)).toEqual([
      'MSFTApple Inc.',
      'AAPLApple Inc.',
      'METAApple Inc.',
      'AMZNApple Inc.',
    ]);
  });

  it.each<[ChipState, string]>([
    ['watching', 'watching'],
    ['approaching', 'approaching'],
    ['at_safe', 'at safe price'],
    ['at_buy', 'at buy price'],
  ])('chip %s reads exactly "%s", with a shape as well as a color', (chip, label) => {
    render(<DashboardTable rows={[makeRow({ chip })]} />);
    const el = document.querySelector(`[data-chip="${chip}"]`);
    expect(el?.textContent).toBe(label);
    // Never color alone: every chip carries its own glyph.
    expect(el?.querySelector('svg')).not.toBeNull();
    expect(document.querySelectorAll('[data-chip]')).toHaveLength(1);
  });

  it('gives each state a distinct glyph, and at_buy the strongest styling', () => {
    const states: ChipState[] = ['watching', 'approaching', 'at_safe', 'at_buy'];
    render(<DashboardTable rows={states.map((chip) => makeRow({ chip }))} />);
    const glyphs = states.map((s) => document.querySelector(`[data-chip="${s}"] svg`)!.innerHTML);
    expect(new Set(glyphs).size).toBe(4);
    const cls = (s: ChipState) => document.querySelector(`[data-chip="${s}"]`)!.className;
    expect(cls('at_buy')).toContain('font-bold');
    expect(cls('at_buy')).toContain('bg-good-solid');
    expect(cls('at_safe')).toContain('font-semibold');
    expect(cls('watching')).not.toMatch(/font-(bold|semibold)/);
  });

  it('shows the stale badge only on stale rows', () => {
    render(
      <DashboardTable
        rows={[
          makeRow({ ticker: 'AAPL', stale: true }),
          makeRow({ ticker: 'MSFT', stale: false }),
          makeRow({ ticker: 'META', stale: true, price: null, changePct: null, quoteAgeMs: null }),
        ]}
      />,
    );
    expect(within(rowFor('AAPL')).getByTestId('stale-badge').textContent).toBe('stale');
    expect(within(rowFor('MSFT')).queryByTestId('stale-badge')).toBeNull();
    // A row with no price can still be stale; the badge must not depend on the price.
    expect(within(rowFor('META')).queryByTestId('stale-badge')).not.toBeNull();
    expect(screen.getAllByTestId('stale-badge')).toHaveLength(2);
  });

  it('renders "—" for null values rather than zero or blank', () => {
    render(
      <DashboardTable
        rows={[
          makeRow({
            price: null,
            changePct: null,
            safe: null,
            buy: null,
            pbtYearsAtPrice: null,
            avgCost: null,
            quoteAgeMs: null,
            chip: 'watching',
            secondary: { pbt: null, mos: null, ten_cap: null },
            sortKey: null,
          }),
        ]}
      />,
    );
    const cells = within(screen.getByTestId('dashboard-row')).getAllByRole('cell');
    // price, (state), (alert), safe, buy, pbt years, avg cost
    const [price, , alert, safe, buy, pbt, avg] = cells.map((c) => c.textContent);
    expect(price).toBe('—');
    expect(alert).toBe('—');
    expect(safe).toBe('—');
    expect(buy).toBe('—');
    expect(pbt).toBe('—');
    expect(avg).toBe('—');
    expect(screen.queryByText(/\$0\.00/)).toBeNull();
    const methods = within(screen.getByTestId('secondary')).getAllByRole('row').slice(1);
    for (const tr of methods) {
      const [buyCell, stickerCell] = within(tr).getAllByRole('cell');
      expect(buyCell!.textContent).toBe('—');
      expect(stickerCell!.textContent).toBe('—');
    }
  });

  it('renders "—" for a null distance and a null % change while the lines still show', () => {
    render(
      <DashboardTable
        rows={[
          makeRow({
            changePct: null,
            safe: { threshold: 200, distance: null },
            buy: { threshold: 121.04, pinned: true, distance: null },
          }),
        ]}
      />,
    );
    expect(screen.getByTestId('change').textContent).toBe('—');
    expect(screen.getByTestId('distance-safe').textContent).toBe('—safe $200.00');
    expect(screen.getByTestId('distance-buy').textContent).toBe('—buy $121.04pinned');
  });

  it('says so when a buy rule has no PBT valuation yet', () => {
    render(<DashboardTable rows={[makeRow({ buy: { threshold: null, pinned: false, distance: null } })]} />);
    expect(screen.getByText('no PBT valuation yet')).toBeTruthy();
  });

  it('renders Infinity Payback Time years as "> 100 yrs"', () => {
    render(
      <DashboardTable
        rows={[
          makeRow({ ticker: 'AAPL', pbtYearsAtPrice: Number.POSITIVE_INFINITY }),
          makeRow({ ticker: 'AMZN', pbtYearsAtPrice: 8.04 }),
        ]}
      />,
    );
    expect(within(rowFor('AAPL')).getByText('> 100 yrs')).toBeTruthy();
    expect(within(rowFor('AMZN')).getByText('8.0 yrs')).toBeTruthy();
  });

  it('shows distances as signed % and $, with "below" spelled out under the line', () => {
    render(
      <DashboardTable
        rows={[
          makeRow({
            safe: { threshold: 200, distance: { dollars: -4.5, pct: -0.0225 } },
            buy: { threshold: 121.04, pinned: false, distance: { dollars: 74.46, pct: 0.6152 } },
          }),
        ]}
      />,
    );
    expect(screen.getByTestId('distance-safe').textContent).toBe('-2.25% below-$4.50safe $200.00');
    expect(screen.getByTestId('distance-buy').textContent).toBe('+61.52% above+$74.46buy $121.04');
  });

  it('reads a sub-cent distance as "at line"', () => {
    render(
      <DashboardTable rows={[makeRow({ safe: { threshold: 200, distance: { dollars: 0.004, pct: 0.00002 } } })]} />,
    );
    expect(screen.getByTestId('distance-safe').textContent).toBe('at line$0.00safe $200.00');
  });

  it('shows price, signed % change and avg cost', () => {
    render(<DashboardTable rows={[makeRow({ price: 1234.5, changePct: 0.0123, avgCost: 228.21 })]} />);
    const row = screen.getByTestId('dashboard-row');
    expect(within(row).getByText('$1,234.50')).toBeTruthy();
    expect(screen.getByTestId('change').textContent).toBe('▲ +1.23%');
    expect(within(row).getByText('$228.21')).toBeTruthy();
  });

  it('renders the open-alert marker apart from the chip', () => {
    render(
      <DashboardTable
        rows={[
          makeRow({
            ticker: 'AAPL',
            chip: 'watching',
            openAlerts: [{ kind: 'safe', threshold: 200, triggeredAt: new Date('2026-09-12T19:55:00Z') }],
          }),
          makeRow({ ticker: 'MSFT', openAlerts: [] }),
        ]}
      />,
    );
    const marker = within(rowFor('AAPL')).getByTestId('open-alert');
    expect(marker.textContent).toBe('safe alert open at $200.00since Sep 12, 3:55 PM EDT');
    // Separate from the chip: the chip still says what PRICE says.
    expect(marker.closest('[data-chip]')).toBeNull();
    expect(rowFor('AAPL').querySelector('[data-chip]')!.textContent).toBe('watching');
    expect(within(rowFor('MSFT')).queryByTestId('open-alert')).toBeNull();
  });

  it('shows the quote age as text next to the price', () => {
    render(
      <DashboardTable
        rows={[
          makeRow({ ticker: 'AAPL', quoteAgeMs: 20 * 60_000 }),
          makeRow({ ticker: 'MSFT', quoteAgeMs: null }),
        ]}
      />,
    );
    expect(within(rowFor('AAPL')).getByTestId('quote-age').textContent).toBe('quote 20m old');
    expect(within(rowFor('MSFT')).getByTestId('quote-age').textContent).toBe('quote age unknown');
  });

  it('expands to all three valuation methods with price and sticker', () => {
    render(<DashboardTable rows={[makeRow()]} />);
    const details = screen.getByTestId('secondary');
    expect(details.tagName).toBe('DETAILS');
    const byMethod = Object.fromEntries(
      within(details)
        .getAllByRole('row')
        .slice(1)
        .map((tr) => [tr.getAttribute('data-method'), tr.textContent]),
    );
    expect(byMethod).toEqual({
      pbt: 'PBT$121.04$242.08',
      mos: 'MOS$150.25$300.50',
      ten_cap: '10 Cap$98.10$196.20',
    });
  });

  it('draws the safe and buy rules on the sparkline', () => {
    render(<DashboardTable rows={[makeRow()]} />);
    const svg = screen.getByTestId('sparkline');
    expect(svg.querySelector('[data-rule="safe"]')).not.toBeNull();
    expect(svg.querySelector('[data-rule="buy"]')).not.toBeNull();
    expect(svg.getAttribute('aria-label')).toBe(
      '3 daily closes, $201.00 to $195.50; safe price $200.00; buy price $121.04',
    );
  });

  it('handles a sparkline with no points or a single point', () => {
    render(
      <DashboardTable
        rows={[
          makeRow({ ticker: 'NONE', sparkline: { points: [], safe: 200, buy: 121.04 } }),
          makeRow({ ticker: 'ONE', sparkline: { points: [{ date: '2026-09-12', close: 150 }], safe: null, buy: null } }),
        ]}
      />,
    );
    expect(within(rowFor('NONE')).getByText('no history')).toBeTruthy();
    expect(within(rowFor('NONE')).queryByTestId('sparkline')).toBeNull();
    const one = within(rowFor('ONE')).getByTestId('sparkline');
    expect(one.querySelector('circle')).not.toBeNull();
    expect(one.querySelector('polyline')).toBeNull();
  });

  it('renders an empty state with no rows', () => {
    render(<DashboardTable rows={[]} />);
    expect(screen.getByText('No active securities.')).toBeTruthy();
  });
});

describe('sparklineGeometry', () => {
  const H = 36;
  const inside = (y: number | null) => y !== null && y >= 0 && y <= H;

  it('keeps rules far outside the price range on the chart', () => {
    // AAPL's shape: closes around $230, buy line at $121, safe line above the closes.
    const g = sparklineGeometry({
      points: [
        { date: 'a', close: 228 },
        { date: 'b', close: 234 },
      ],
      safe: 260,
      buy: 121.04,
    });
    expect(inside(g.safeY)).toBe(true);
    expect(inside(g.buyY)).toBe(true);
    // Higher price, smaller y: safe sits above the closes, buy at the bottom.
    expect(g.safeY!).toBeLessThan(g.buyY!);
    expect(g.buyY).toBe(H - 3);
    expect(g.safeY).toBe(3);
  });

  it('does not divide by zero on a flat series', () => {
    const g = sparklineGeometry({
      points: [
        { date: 'a', close: 100 },
        { date: 'b', close: 100 },
      ],
      safe: null,
      buy: null,
    });
    expect(g.line).toBe('3,18 117,18');
  });

  it('returns nothing to draw with no points and no rules', () => {
    expect(sparklineGeometry({ points: [], safe: null, buy: null })).toEqual({
      line: null,
      dot: null,
      safeY: null,
      buyY: null,
    });
  });
});

describe('format', () => {
  it('signs percentages and never shows "-0.00%"', () => {
    expect(formatSignedPct(0.05)).toBe('+5.00%');
    expect(formatSignedPct(-0.05)).toBe('-5.00%');
    expect(formatSignedPct(-0.00001)).toBe('0.00%');
  });

  it('coarsens quote age', () => {
    expect(formatQuoteAge(-5_000)).toBe('quote <1m old');
    expect(formatQuoteAge(59_999)).toBe('quote <1m old');
    expect(formatQuoteAge(20 * 60_000 + 59_000)).toBe('quote 20m old');
    expect(formatQuoteAge(3 * 3_600_000)).toBe('quote 3h old');
    expect(formatQuoteAge(3 * 86_400_000)).toBe('quote 3d old');
  });
});

describe('DemoBanner', () => {
  it('labels the demo database', () => {
    render(<DemoBanner />);
    expect(screen.getByTestId('demo-banner').textContent).toMatch(/^DEMO/);
    expect(screen.getByTestId('demo-banner').textContent).toContain('fabricated');
  });
});

describe('AutoRefresh', () => {
  const setVisibility = (state: DocumentVisibilityState) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  };

  afterEach(() => setVisibility('visible'));

  it('refreshes every 60 s and pauses while the tab is hidden', () => {
    vi.useFakeTimers();
    setVisibility('visible');
    render(<AutoRefresh />);

    act(() => vi.advanceTimersByTime(60_000));
    expect(refresh).toHaveBeenCalledTimes(1);

    act(() => setVisibility('hidden'));
    act(() => vi.advanceTimersByTime(180_000));
    expect(refresh).toHaveBeenCalledTimes(1);

    // Back after more than an interval: refresh at once, then resume the cadence.
    act(() => setVisibility('visible'));
    expect(refresh).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(60_000));
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('stops on unmount', () => {
    vi.useFakeTimers();
    setVisibility('visible');
    const { unmount } = render(<AutoRefresh />);
    unmount();
    act(() => vi.advanceTimersByTime(300_000));
    expect(refresh).not.toHaveBeenCalled();
  });
});

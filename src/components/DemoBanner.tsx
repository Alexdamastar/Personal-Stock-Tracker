/**
 * Shown when DATABASE_URL is unset and the app is running on the in-process PGlite
 * demo database. Its prices are fabricated, so the banner is loud and sits above the
 * table: a demo price mistaken for a real one is the failure this exists to prevent.
 */
export function DemoBanner() {
  return (
    <div
      role="note"
      data-testid="demo-banner"
      className="border-b-4 border-warn bg-warn-tint px-4 py-3 text-sm text-warn-ink"
    >
      <p className="mx-auto max-w-7xl">
        <strong className="mr-2 rounded bg-warn-ink px-1.5 py-0.5 font-bold tracking-widest text-warn-tint">
          DEMO
        </strong>
        Prices are fabricated. This is an in-process demo database, not market data. Set{' '}
        <code className="font-mono">DATABASE_URL</code> to use a real database.
      </p>
    </div>
  );
}

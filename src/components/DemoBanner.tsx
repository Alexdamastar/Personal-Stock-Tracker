/**
 * Shown when DATABASE_URL is unset and the app is running on the in-process PGlite
 * demo database. Its prices are fabricated, so the banner must be impossible to miss:
 * a demo price mistaken for a real one is the failure this exists to prevent.
 *
 * DESIGN.md has no warning component. Its one loud element is the full-bleed deep
 * indigo "night" band, reserved for a single moment per page, and the dashboard has
 * no other hero to spend it on (decision 2026-09-13). The DEMO label is DESIGN.md's
 * badge-pill: white, primary-blue text, eyebrow type, fully rounded.
 */
export function DemoBanner() {
  return (
    <div
      role="note"
      data-testid="demo-banner"
      className="bg-secondary px-4 py-3 text-caption text-on-primary"
    >
      <p className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-1">
        {/* Fixed white and fixed #0075de, not the theme tokens: the indigo band is the
            same in both color schemes, so its contents must not follow the dark swap. */}
        <strong className="rounded-full bg-white px-2 py-1 text-eyebrow font-semibold tracking-widest text-[#0075de]">
          DEMO
        </strong>
        <span>
          Prices are fabricated. This is an in-process demo database, not market data. Set{' '}
          <code className="rounded-xs bg-white/15 px-1 py-px font-mono text-eyebrow">DATABASE_URL</code> to use a
          real database.
        </span>
      </p>
    </div>
  );
}

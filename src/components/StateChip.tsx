import type { ChipState } from '../lib/dashboard-types.js';

/**
 * The spec's four chip labels, verbatim. Tests and the acceptance criterion match on
 * these strings, so they are data rather than JSX text.
 */
export const CHIP_LABELS: Record<ChipState, string> = {
  watching: 'watching',
  approaching: 'approaching',
  at_safe: 'at safe price',
  at_buy: 'at buy price',
};

/**
 * Every state differs in shape and text as well as color, so the chip survives
 * grayscale, color blindness and forced-colors mode. Emphasis climbs with the state:
 * a hollow outline, a tinted warning, a bordered tint, then a solid fill for at_buy
 * (the user asked for at_buy strongest, then at_safe).
 */
const CHIP_CLASSES: Record<ChipState, string> = {
  watching: 'border border-line text-muted',
  approaching: 'border border-warn bg-warn-tint text-warn-ink',
  at_safe: 'border-2 border-good bg-good-tint text-good-ink font-semibold',
  at_buy: 'border-2 border-good-solid bg-good-solid text-on-good-solid font-bold shadow-sm',
};

function ChipIcon({ state }: { state: ChipState }) {
  // 12px glyphs in currentColor so each shape inherits the chip's own contrast.
  const common = { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true, focusable: false } as const;
  switch (state) {
    case 'watching':
      // Hollow circle: nothing to act on.
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case 'approaching':
      // Downward triangle: price is closing on a line from above.
      return (
        <svg {...common}>
          <path d="M1.5 2.5h9L6 10.5z" fill="currentColor" />
        </svg>
      );
    case 'at_safe':
      // Filled diamond.
      return (
        <svg {...common}>
          <path d="M6 0.75 11.25 6 6 11.25 0.75 6z" fill="currentColor" />
        </svg>
      );
    case 'at_buy':
      // Star: the one state that means "this is the price you were waiting for".
      return (
        <svg {...common}>
          <path
            d="M6 0.6 7.6 4.1 11.4 4.5 8.55 7.05 9.35 10.8 6 8.9 2.65 10.8 3.45 7.05 0.6 4.5 4.4 4.1z"
            fill="currentColor"
          />
        </svg>
      );
  }
}

export function StateChip({ state }: { state: ChipState }) {
  return (
    <span
      data-chip={state}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs ${CHIP_CLASSES[state]}`}
    >
      <ChipIcon state={state} />
      {CHIP_LABELS[state]}
    </span>
  );
}

/**
 * One live quote fetch, for checking API keys. Spends real provider budget, so it is
 * a manual script and never part of `npm test`.
 *
 *   npx tsx --env-file=.env scripts/quote.ts [TICKER...]
 */
import { createQuoteService } from '../src/providers/index.js';

const tickers = process.argv.slice(2);
const result = await createQuoteService().getQuotes(tickers.length ? tickers : ['AAPL']);

for (const q of result.quotes) {
  console.log(`${q.ticker.padEnd(6)} $${q.price}  prevClose ${q.prevClose ?? '—'}  at ${q.at?.toISOString() ?? 'null'}  via ${q.provider}`);
}
for (const [ticker, kind] of result.failures) console.log(`${ticker.padEnd(6)} FAILED: ${kind}`);
console.log(`\n${result.quotes.length} quote(s), ${result.failures.size} failure(s)`);

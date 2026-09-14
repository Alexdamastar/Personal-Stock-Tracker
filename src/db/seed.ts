import { eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';
import { AMZN_FIXTURE_INPUT, SEED_AS_OF, SEED_ROWS, resolvedSticker } from './seed-data.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Idempotent seed of the §4 table. Safe to re-run.
 *
 * `valuations` is APPEND-ONLY (§4) — this never UPDATEs a valuation row. Re-running
 * is made idempotent by skipping securities that already have a seeded manual PBT
 * row for SEED_AS_OF, so a second run does not fabricate duplicate history.
 */
export async function seed(db: Db): Promise<{ inserted: string[]; skipped: string[] }> {
  const inserted: string[] = [];
  const skipped: string[] = [];

  for (const row of SEED_ROWS) {
    const [security] = await db
      .insert(schema.securities)
      .values({ ticker: row.ticker, name: row.name })
      .onConflictDoUpdate({
        target: schema.securities.ticker,
        set: { name: row.name },
      })
      .returning();
    if (!security) throw new Error(`failed to upsert security ${row.ticker}`);

    const existing = await db
      .select({ id: schema.valuations.id })
      .from(schema.valuations)
      .where(eq(schema.valuations.securityId, security.id));

    if (existing.length === 0) {
      await db.insert(schema.valuations).values({
        securityId: security.id,
        method: 'pbt',
        buyPrice: row.buy,
        stickerPrice: resolvedSticker(row),
        mosPct: 0.5,
        growthRate: row.ticker === 'AMZN' ? AMZN_FIXTURE_INPUT.g : null,
        marr: row.ticker === 'AMZN' ? AMZN_FIXTURE_INPUT.marr : null,
        inputs: row.ticker === 'AMZN'
          ? { provenance: 'rule1-toolbox-panel', ...AMZN_FIXTURE_INPUT }
          : { provenance: 'rule1-toolbox-panel', note: 'full input panel not captured (§9)' },
        source: 'manual',
        asOf: SEED_AS_OF,
      });
      inserted.push(row.ticker);
    } else {
      skipped.push(row.ticker);
    }

    // kind='buy' with value NULL follows the latest PBT valuation automatically (D1/§4).
    await db.insert(schema.watchRules)
      .values({ securityId: security.id, kind: 'buy', value: null })
      .onConflictDoNothing();

    // D3: safe price is optional. No row at all when the user has not set one.
    if (row.safe !== null) {
      await db.insert(schema.watchRules)
        .values({ securityId: security.id, kind: 'safe', value: row.safe })
        .onConflictDoUpdate({
          target: [schema.watchRules.securityId, schema.watchRules.kind],
          set: { value: row.safe },
        });
    }

    if (row.avgCost !== null) {
      await db.insert(schema.positions)
        .values({ securityId: security.id, avgCost: row.avgCost })
        .onConflictDoUpdate({
          target: schema.positions.securityId,
          set: { avgCost: row.avgCost },
        });
    }
  }

  return { inserted, skipped };
}

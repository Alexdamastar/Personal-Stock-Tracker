import { createDb } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';

const { db, sql } = createDb();
const result = await seed(db);
await sql.end();
console.log(`seeded: inserted=[${result.inserted.join(', ')}] skipped=[${result.skipped.join(', ')}]`);

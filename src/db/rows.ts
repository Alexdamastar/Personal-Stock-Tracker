/**
 * DEFECT-13 (found during M1): `db.execute()` result shapes differ by driver.
 *   postgres.js -> a RowList, i.e. an ARRAY
 *   PGlite/node-postgres -> an object with `.rows`
 *
 * Code that reads `.rows` works in the PGlite test harness and breaks in
 * production, and code that treats the result as an array does the reverse.
 * All raw-SQL call sites go through this.
 *
 * Also note: raw `execute()` bypasses Drizzle's column mapping, so `numeric`
 * columns come back as STRINGS here even though the schema declares
 * mode:'number'. Query-builder calls are unaffected. Parse explicitly.
 */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    return (result as { rows: T[] }).rows;
  }
  throw new TypeError(`unrecognized query result shape: ${Object.prototype.toString.call(result)}`);
}

import type { DashboardData } from '../lib/dashboard-types.js';
import type { Db } from './seed.js';

/**
 * §5 M5 loader: everything the dashboard needs, read from the database.
 *
 * STUB — the M5 fan-out replaces this file. The signature is the contract.
 */
export async function loadDashboardData(_db: Db): Promise<DashboardData> {
  throw new Error('not implemented: dashboard loader (M5 fan-out)');
}

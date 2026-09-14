import type { DashboardData, DashboardDeps, DashboardRow } from './dashboard-types.js';

/**
 * §5 M5 view model: raw dashboard data -> sorted rows. Pure.
 *
 * STUB — the M5 fan-out replaces this file. The signature is the contract.
 */
export function buildDashboardRows(
  _data: DashboardData,
  _now: Date,
  _deps: DashboardDeps,
): DashboardRow[] {
  throw new Error('not implemented: dashboard view model (M5 fan-out)');
}

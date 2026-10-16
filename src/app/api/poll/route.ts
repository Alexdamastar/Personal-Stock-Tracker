import { getAppDb } from '../../../db/app-db.js';
import { isAuthorized, runPoll } from '../../../db/poll.js';
import { createQuoteService } from '../../../providers/index.js';

/** §5 M3 — called every 5 min by the scheduler (worker/). POST with `Authorization: Bearer $POLL_TOKEN`. */
export async function POST(req: Request) {
  if (!isAuthorized(req.headers.get('authorization'), process.env.POLL_TOKEN)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { db, mode } = await getAppDb();
  // Demo prices are invented; polling them would spend real provider budget on a throwaway database.
  if (mode === 'demo') return Response.json({ error: 'DATABASE_URL is not set' }, { status: 503 });

  const report = await runPoll(db, createQuoteService());
  // Nothing written while open = a dead poll; a non-2xx makes it visible in the scheduler's logs.
  const dead = report.status === 'polled' && report.written.length === 0;
  return Response.json(report, { status: dead ? 502 : 200 });
}

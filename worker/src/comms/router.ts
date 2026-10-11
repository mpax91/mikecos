import { Hono } from 'hono';
import type { Env } from '../types';
import { findCommsFolder, loadCommSettings, runComms } from './ingest';
import { goneQuiet } from './read';

/** /api/comms — Calls & Texts (phone backup rollups). */
export const commsRouter = new Hono<{ Bindings: Env }>();

commsRouter.get('/settings', async (c) => {
  const s = await loadCommSettings(c.env);
  const counts = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM comm_last) AS numbers, (SELECT COUNT(*) FROM comm_groups) AS groups,
            (SELECT COALESCE(SUM(n),0) FROM comm_monthly WHERE kind LIKE 'call%') AS calls,
            (SELECT COALESCE(SUM(n),0) FROM comm_monthly WHERE kind IN ('text_in','text_out')) AS texts,
            (SELECT COALESCE(SUM(n),0) FROM comm_monthly WHERE kind = 'group_in') AS group_msgs`
  ).first<{ numbers: number; groups: number; calls: number; texts: number; group_msgs: number }>();
  const ms = (v: number | null) => (v ? new Date(v).toISOString() : null);
  return c.json({
    folder: s.folder_id ? { name: s.folder_name, url: s.folder_url } : null,
    lastScanAt: s.last_scan_at,
    lastError: s.last_error,
    callsThrough: ms(s.calls_wm),
    textsThrough: ms(s.sms_wm),
    chatsThrough: ms(s.mms_wm),
    chatsCaughtUp: !!s.mms_done,
    firstAt: ms(s.first_at),
    counts,
  });
});

commsRouter.get('/folders', async (c) => {
  const f = await findCommsFolder(c.env);
  return c.json(f ? [f] : []);
});

commsRouter.post('/scan', async (c) => c.json(await runComms(c.env)));

commsRouter.get('/quiet', async (c) => c.json(await goneQuiet(c.env)));

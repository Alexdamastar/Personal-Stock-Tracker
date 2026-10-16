// §5 M3 scheduler: a Cloudflare Workers Cron Trigger that calls /api/poll. Cron is UTC-only
// (DEFECT-03), so wrangler.toml fires on a window covering both EST and EDT and the route's
// ET gate decides; off-session calls return {"status":"closed"} and spend nothing.
// The Worker holds no logic and no database connection (Workers cannot open raw TCP).
export default {
  async scheduled(_event, env) {
    const res = await fetch(env.POLL_URL, { method: 'POST', headers: { authorization: `Bearer ${env.POLL_TOKEN}` } });
    // Throwing marks the invocation failed in the Cloudflare dashboard.
    if (!res.ok) throw new Error(`poll ${res.status}: ${(await res.text()).slice(0, 500)}`);
  },
};

#!/usr/bin/env node
// Nightly Bing Webmaster pull for the Bedford Bee dashboard, run by GitHub
// Actions (.github/workflows/bing-pull.yml) instead of the Cloudflare Worker,
// because Bing throttles Cloudflare's shared outbound IPs ("ThrottleIP").
// Fetches the same four reports the Worker does and posts them to
// POST /api/bee/bing/import, which stores them exactly like a Worker sync.
//
// THIS REPO IS PUBLIC, so Actions logs are public: print counts and status
// codes only — never Bing data, the site's search terms, keys or URLs with
// keys in them.
//
// Env: BING_API_KEY, BEE_IMPORT_KEY (both GitHub repo secrets),
//      MIKEOS_API (optional, defaults to the live API).
// No dependencies — Node 18+ (global fetch).

const BASE = 'https://ssl.bing.com/webmaster/api.svc/json';
const SITE_HINT = 'thebedfordbee.com';
const API = (process.env.MIKEOS_API || 'https://mikeos-api.michaelpalladino.workers.dev').replace(/\/$/, '');
const KEY = process.env.BING_API_KEY;
const IMPORT_KEY = process.env.BEE_IMPORT_KEY;

if (!KEY || !IMPORT_KEY) {
  console.error('Missing secret: set BING_API_KEY and BEE_IMPORT_KEY in the repo’s Actions secrets.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BACKOFF_MS = [5000, 15000, 45000, 90000];

async function call(method, params = {}) {
  const qs = new URLSearchParams({ ...params, apikey: KEY });
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${BASE}/${method}?${qs}`, { headers: { Accept: 'application/json', 'User-Agent': 'MikeOS/1.0 (Bedford Bee dashboard; GitHub Actions)' } });
    if (r.ok) return (await r.json()).d;
    const body = await r.text();
    if (/Throttle/i.test(body) || r.status === 429) {
      if (attempt < BACKOFF_MS.length) {
        console.log(`${method}: throttled, retrying in ${BACKOFF_MS[attempt] / 1000}s`);
        await sleep(BACKOFF_MS[attempt]);
        continue;
      }
      throw new Error(`${method}: Bing is still throttling after ${BACKOFF_MS.length} retries`);
    }
    if (r.status === 401 || /InvalidApiKey|NotAuthorized/i.test(body)) throw new Error(`${method}: Bing rejected the API key (BING_API_KEY secret)`);
    throw new Error(`${method}: Bing HTTP ${r.status}`);
  }
}

const sites = (await call('GetUserSites')) ?? [];
const ours = sites.filter((s) => String(s.Url).toLowerCase().includes(SITE_HINT));
const site = (ours.find((s) => s.IsVerified !== false) ?? ours[0])?.Url;
if (!site) {
  console.error(`The Bing key works, but its account has no ${SITE_HINT} site.`);
  process.exit(1);
}
// One call at a time — parallel calls make Bing's throttling worse.
const queries = (await call('GetQueryStats', { siteUrl: site })) ?? [];
const pages = (await call('GetPageStats', { siteUrl: site })) ?? [];
const traffic = (await call('GetRankAndTrafficStats', { siteUrl: site })) ?? [];
let issues = [];
try {
  issues = (await call('GetCrawlIssues', { siteUrl: site })) ?? [];
} catch {
  console.log('GetCrawlIssues failed — sending none');
}
console.log(`Bing: ${queries.length} search rows, ${pages.length} page rows, ${traffic.length} days, ${issues.length} crawl issues`);

const r = await fetch(`${API}/api/bee/bing/import`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Import-Key': IMPORT_KEY },
  body: JSON.stringify({ site, queries, pages, traffic, issues }),
});
if (!r.ok) {
  console.error(`MikeOS import failed: HTTP ${r.status}${r.status === 401 ? ' — BEE_IMPORT_KEY doesn’t match the Worker secret' : ''}`);
  process.exit(1);
}
const res = await r.json();
console.log(`MikeOS: stored ${res.weeks} weeks, ${res.days} days`);

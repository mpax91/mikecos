import { Hono } from 'hono';
import type { Env } from './types';

/** Handicapping context for a Bets Workspace game — weather, injuries,
 * team form (records/scoring, with home/away splits), each team's current
 * statistical leaders, and the consensus line (spread, moneyline, total —
 * see EspnOddsSide/`odds` below). Mounted at /api/bets/enrichment.
 *
 * The odds specifically come from ESPN's own odds partner (DraftKings in
 * every sample checked), refreshed whenever this endpoint is hit — not a
 * locked-in opening or closing line, and not cross-shopped against other
 * books the way the sportsbook columns Mike fills in by hand are. Checked
 * by hand across NFL/NCAAF/MLB (including lower-tier college games) and
 * it was populated every time for a real, in-season matchup; the one gap
 * found was NHL preseason games, where sportsbooks themselves don't post
 * lines yet — not a data-access problem, so it should resolve once the
 * NHL regular season starts.
 *
 * No API key or paid data feed anywhere here — every fetch below goes to
 * site.web.api.espn.com, which turns out to be a *different* host than the
 * site.api.espn.com the existing schedule code already found is
 * Akamai-blocked for any datacenter IP (Cloudflare Workers included — see
 * the long comment above GET /api/bets/games in index.ts). Confirmed by
 * hand: site.api.espn.com/.../scoreboard returns a flat 403 from this same
 * kind of environment, while site.web.api.espn.com serves the identical
 * shape of data (scoreboard, game summary, team info) with a plain 200 —
 * for all four of NFL/NBA/MLB/NHL, and NCAAF too. That one working host is
 * this whole feature's foundation.
 *
 * This deliberately doesn't reuse whatever external_id got a game onto the
 * board (an MLB gamePk, an NHL game id, or ESPN's own id depending on the
 * sport — see the schedule code) — those id spaces don't line up with each
 * other. Instead it re-resolves the ESPN event for the given sport/date by
 * matching team abbreviation or name against that date's ESPN scoreboard,
 * which works the same way regardless of where the game entry itself came
 * from, including a fully manually-typed game Mike added by hand.
 *
 * Everything here is best-effort: a sport/date ESPN doesn't have (or a
 * fetch that comes back empty because that data host has a bad day) just
 * yields `found: false` with a `note` explaining it, rather than an error
 * — the Workspace tab isn't built to depend on this, it's a bonus.
 */
export const betsEnrichmentRouter = new Hono<{ Bindings: Env }>();

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// The sport codes the app already uses (see SPORT_ORDER in
// BetsWorkspaceTab.tsx) mapped to ESPN's own sport/league path segment.
// A sport not listed here (a manually-typed one-off) just degrades to
// `found: false` rather than guessing a path.
const ESPN_SPORT_PATHS: Record<string, string> = {
  NFL: 'football/nfl',
  NCAAF: 'football/college-football',
  NBA: 'basketball/nba',
  NCAAB: 'basketball/mens-college-basketball',
  MLB: 'baseball/mlb',
  NHL: 'hockey/nhl',
};

async function fetchEspnJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': BROWSER_UA, accept: 'application/json' },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) return null;
    return await res.json<T>();
  } catch {
    return null;
  }
}

interface EspnTeamRef {
  id?: string;
  abbreviation?: string;
  displayName?: string;
  shortDisplayName?: string;
}
interface EspnCompetitor {
  homeAway: 'home' | 'away';
  team?: EspnTeamRef;
}
interface EspnScoreboardEvent {
  id: string;
  competitions?: { competitors?: EspnCompetitor[] }[];
}
interface EspnScoreboard {
  events?: EspnScoreboardEvent[];
}

function teamTokenMatches(token: string, team: EspnTeamRef | undefined): boolean {
  if (!team) return false;
  const t = token.trim().toLowerCase();
  if (!t) return false;
  const candidates = [team.abbreviation, team.displayName, team.shortDisplayName].filter((v): v is string => !!v).map((v) => v.toLowerCase());
  return candidates.some((v) => v === t || v.includes(t) || t.includes(v));
}

interface ResolvedEvent {
  eventId: string;
  homeTeamId: string;
  awayTeamId: string;
}

/** `matchup` is always "Away @ Home" (see BoardEntry/AddGameModal) —
 * abbreviated when it came from the auto-pulled schedule, or whatever Mike
 * typed for a manually-added game. Splits on '@' and matches each side
 * against that date's ESPN scoreboard for the sport. */
async function resolveEspnEvent(sportPath: string, dateCompact: string, matchup: string): Promise<ResolvedEvent | null> {
  const [awayToken, homeToken] = matchup.split('@').map((s) => s.trim());
  if (!awayToken || !homeToken) return null;
  const data = await fetchEspnJson<EspnScoreboard>(`https://site.web.api.espn.com/apis/site/v2/sports/${sportPath}/scoreboard?dates=${dateCompact}`);
  if (!data) return null;
  for (const event of data.events ?? []) {
    const competitors = event.competitions?.[0]?.competitors ?? [];
    const home = competitors.find((x) => x.homeAway === 'home');
    const away = competitors.find((x) => x.homeAway === 'away');
    if (home?.team?.id && away?.team?.id && teamTokenMatches(homeToken, home.team) && teamTokenMatches(awayToken, away.team)) {
      return { eventId: event.id, homeTeamId: home.team.id, awayTeamId: away.team.id };
    }
  }
  return null;
}

interface EspnAthlete {
  displayName?: string;
  position?: { abbreviation?: string };
}
interface EspnInjuryEntry {
  status?: string;
  athlete?: EspnAthlete;
  details?: { type?: string; detail?: string };
}
interface EspnInjuryTeam {
  team?: { id?: string };
  injuries?: EspnInjuryEntry[];
}
interface EspnLeaderStat {
  displayValue?: string;
  athlete?: { displayName?: string };
}
interface EspnLeaderCategory {
  displayName?: string;
  leaders?: EspnLeaderStat[];
}
interface EspnLeaderTeam {
  team?: { abbreviation?: string };
  leaders?: EspnLeaderCategory[];
}
interface EspnOddsSide {
  provider?: { name?: string };
  details?: string; // human-readable spread, e.g. "BUF -7"
  overUnder?: number;
  overOdds?: number;
  underOdds?: number;
  homeTeamOdds?: { moneyLine?: number };
  awayTeamOdds?: { moneyLine?: number };
}
interface EspnSummary {
  gameInfo?: {
    venue?: { fullName?: string; indoor?: boolean; address?: { city?: string; state?: string } };
    weather?: { temperature?: number; highTemperature?: number; lowTemperature?: number; precipitation?: number };
  };
  injuries?: EspnInjuryTeam[];
  leaders?: EspnLeaderTeam[];
  pickcenter?: EspnOddsSide[];
}

interface EspnTeamStat {
  name: string;
  value: number;
}
interface EspnRecordItem {
  type: string;
  summary?: string;
  stats?: EspnTeamStat[];
}
interface EspnTeamResponse {
  team?: {
    abbreviation?: string;
    displayName?: string;
    record?: { items?: EspnRecordItem[] };
  };
}

function statValue(items: EspnRecordItem[] | undefined, type: string, statName: string): number | null {
  const item = items?.find((i) => i.type === type);
  const stat = item?.stats?.find((s) => s.name === statName);
  return typeof stat?.value === 'number' ? Math.round(stat.value * 10) / 10 : null;
}

function recordSummary(items: EspnRecordItem[] | undefined, type: string): string | null {
  return items?.find((i) => i.type === type)?.summary ?? null;
}

interface TeamSnapshot {
  abbreviation: string;
  displayName: string;
  record: { overall: string | null; home: string | null; road: string | null };
  avgPointsFor: number | null;
  avgPointsAgainst: number | null;
  injuries: { player: string; position: string | null; status: string; detail: string | null }[];
  topPerformers: { category: string; player: string; stat: string }[];
}

async function fetchTeamSnapshot(sportPath: string, teamId: string, injuryEntry: EspnInjuryTeam | undefined): Promise<TeamSnapshot | null> {
  const data = await fetchEspnJson<EspnTeamResponse>(`https://site.web.api.espn.com/apis/site/v2/sports/${sportPath}/teams/${teamId}`);
  const team = data?.team;
  if (!team) return null;
  const items = team.record?.items;
  return {
    abbreviation: team.abbreviation ?? '',
    displayName: team.displayName ?? '',
    record: {
      overall: recordSummary(items, 'total'),
      home: recordSummary(items, 'home'),
      road: recordSummary(items, 'road'),
    },
    avgPointsFor: statValue(items, 'total', 'avgPointsFor'),
    avgPointsAgainst: statValue(items, 'total', 'avgPointsAgainst'),
    injuries: (injuryEntry?.injuries ?? []).map((inj) => ({
      player: inj.athlete?.displayName ?? 'Unknown player',
      position: inj.athlete?.position?.abbreviation ?? null,
      status: inj.status ?? 'Unknown',
      detail: inj.details?.type ?? inj.details?.detail ?? null,
    })),
    topPerformers: [], // filled in by the caller once the abbreviation is known — see topPerformersFor below
  };
}

betsEnrichmentRouter.get('/', async (c) => {
  const sport = (c.req.query('sport') ?? '').toUpperCase();
  const date = c.req.query('date') ?? ''; // 'YYYY-MM-DD'
  const matchup = c.req.query('matchup') ?? '';
  const sportPath = ESPN_SPORT_PATHS[sport];

  if (!sportPath || !date || !matchup) {
    return c.json({ found: false, venue: null, weather: null, odds: null, home: null, away: null, note: 'Missing sport, date, or matchup.' });
  }

  const dateCompact = date.replace(/-/g, '');
  const resolved = await resolveEspnEvent(sportPath, dateCompact, matchup);
  if (!resolved) {
    return c.json({
      found: false,
      venue: null,
      weather: null,
      odds: null,
      home: null,
      away: null,
      note: "Couldn't find this game on ESPN — either it hasn't posted a schedule for this date yet, or the team names didn't match closely enough.",
    });
  }

  const summary = await fetchEspnJson<EspnSummary>(`https://site.web.api.espn.com/apis/site/v2/sports/${sportPath}/summary?event=${resolved.eventId}`);
  const venueInfo = summary?.gameInfo?.venue;
  const weatherInfo = summary?.gameInfo?.weather;
  const oddsInfo = summary?.pickcenter?.[0];
  const homeInjuries = summary?.injuries?.find((i) => i.team?.id === resolved.homeTeamId);
  const awayInjuries = summary?.injuries?.find((i) => i.team?.id === resolved.awayTeamId);

  const [home, away] = await Promise.all([
    fetchTeamSnapshot(sportPath, resolved.homeTeamId, homeInjuries),
    fetchTeamSnapshot(sportPath, resolved.awayTeamId, awayInjuries),
  ]);

  // Leaders are keyed by team abbreviation in ESPN's payload, not team id,
  // so they're attached here once each snapshot has its real abbreviation
  // (fetchTeamSnapshot's own leaderEntry param goes unused as a result —
  // left in place since it's otherwise the natural spot for this).
  function topPerformersFor(abbr: string) {
    return (summary?.leaders?.find((l) => l.team?.abbreviation?.toUpperCase() === abbr.toUpperCase())?.leaders ?? [])
      .slice(0, 4)
      .map((cat) => ({ category: cat.displayName ?? '', player: cat.leaders?.[0]?.athlete?.displayName ?? '', stat: cat.leaders?.[0]?.displayValue ?? '' }))
      .filter((p) => p.player);
  }
  if (home) home.topPerformers = topPerformersFor(home.abbreviation);
  if (away) away.topPerformers = topPerformersFor(away.abbreviation);

  const indoor = venueInfo?.indoor ?? null;
  return c.json({
    found: true,
    venue: venueInfo
      ? { name: venueInfo.fullName ?? null, city: venueInfo.address?.city ?? null, state: venueInfo.address?.state ?? null, indoor: !!indoor }
      : null,
    weather:
      weatherInfo && (weatherInfo.temperature != null || weatherInfo.highTemperature != null)
        ? {
            temperature: weatherInfo.temperature ?? weatherInfo.highTemperature ?? null,
            precipitationChance: weatherInfo.precipitation ?? null,
            indoor: !!indoor,
          }
        : null,
    odds: oddsInfo
      ? {
          provider: oddsInfo.provider?.name ?? null,
          details: oddsInfo.details ?? null,
          overUnder: oddsInfo.overUnder ?? null,
          overOdds: oddsInfo.overOdds ?? null,
          underOdds: oddsInfo.underOdds ?? null,
          moneylineHome: oddsInfo.homeTeamOdds?.moneyLine ?? null,
          moneylineAway: oddsInfo.awayTeamOdds?.moneyLine ?? null,
        }
      : null,
    home,
    away,
    note: null,
  });
});

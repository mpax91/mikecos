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

// Open-vs-current odds — ESPN's pickcenter carries both for spread, total,
// and moneyline (confirmed by hand against a real pregame MLB matchup), not
// just a single current-snapshot line the way the old /pickcenter[0].details
// text did. Values here are always the raw strings ESPN sends ("+1.5",
// "o7.5", "-292") — parsed in the handler below, not here.
interface EspnOddsLineOdds {
  line?: string;
  odds?: string;
}
interface EspnOddsSideOU {
  open?: EspnOddsLineOdds;
  close?: EspnOddsLineOdds;
}
interface EspnOddsSpread {
  home?: EspnOddsSideOU;
  away?: EspnOddsSideOU;
}
interface EspnOddsTotal {
  over?: EspnOddsSideOU;
  under?: EspnOddsSideOU;
}
interface EspnOddsMoneyline {
  home?: EspnOddsSideOU;
  away?: EspnOddsSideOU;
}
interface EspnOddsSide {
  provider?: { name?: string };
  pointSpread?: EspnOddsSpread;
  total?: EspnOddsTotal;
  moneyline?: EspnOddsMoneyline;
}

// Probable starting pitcher (MLB only — absent/undefined for every other
// sport, which just yields a null pitcher on that team's snapshot). Lives
// under header.competitions[0].competitors[].probables, not under the team
// snapshot endpoint, so it's read straight off the summary fetch.
interface EspnStatCategory {
  name?: string;
  displayValue?: string;
}
interface EspnProbable {
  athlete?: { displayName?: string; throws?: { abbreviation?: string } };
  statistics?: { splits?: { categories?: EspnStatCategory[] } };
}
interface EspnHeaderCompetitor {
  id?: string;
  homeAway?: 'home' | 'away';
  probables?: EspnProbable[];
}
interface EspnHeader {
  competitions?: { competitors?: EspnHeaderCompetitor[] }[];
}

// Head-to-head history — three tiers (current series / this year's earlier
// meetings / full regular-season series), each with a human summary string
// and the individual games. "Last 5 meetings" below is sliced from whichever
// tier covers the most games (season, falling back to current).
interface EspnSeasonSeriesCompetitor {
  homeAway?: 'home' | 'away';
  winner?: boolean;
  score?: string;
  team?: { abbreviation?: string };
}
interface EspnSeasonSeriesEvent {
  date?: string;
  status?: string; // 'pre' | 'in' | 'post' — only 'post' has a real final score
  competitors?: EspnSeasonSeriesCompetitor[];
}
interface EspnSeasonSeriesEntry {
  type?: string; // 'current' | 'preseason' | 'season'
  summary?: string;
  events?: EspnSeasonSeriesEvent[];
}

// Each team's last 5 actual games — straight win/loss, not against-the-spread
// (ESPN's own againstTheSpread field came back with an empty records array on
// every real game checked, so it isn't a reliable source — see the note atop
// this file).
interface EspnLastFiveEvent {
  gameDate?: string;
  score?: string;
  gameResult?: string; // 'W' | 'L'
  atVs?: string; // '@' | 'vs'
  opponent?: { abbreviation?: string };
}
interface EspnLastFiveTeam {
  team?: { id?: string };
  events?: EspnLastFiveEvent[];
}

// ESPN's own model-based win probability — a free, real number, but a model
// output rather than a human tipster's pick, so it's surfaced in the UI
// labeled as "ESPN Projection", never as an "expert pick".
interface EspnPredictor {
  homeTeam?: { id?: string; gameProjection?: string };
  awayTeam?: { id?: string; gameProjection?: string };
}

// NHL's starting-goalie equivalent of MLB's probable pitcher — a separate
// top-level field (not under header.competitions[].probables the way
// baseball's is), keyed by homeTeam/awayTeam rather than a homeAway string.
interface EspnGoalieTeam {
  athletes?: { displayName?: string; statistics?: EspnStatCategory[] }[];
}
interface EspnGoalies {
  homeTeam?: EspnGoalieTeam;
  awayTeam?: EspnGoalieTeam;
}

interface EspnSummary {
  gameInfo?: {
    venue?: { fullName?: string; indoor?: boolean; address?: { city?: string; state?: string } };
    weather?: { temperature?: number; highTemperature?: number; lowTemperature?: number; precipitation?: number; gust?: number };
  };
  injuries?: EspnInjuryTeam[];
  leaders?: EspnLeaderTeam[];
  pickcenter?: EspnOddsSide[];
  header?: EspnHeader;
  seasonseries?: EspnSeasonSeriesEntry[];
  lastFiveGames?: EspnLastFiveTeam[];
  predictor?: EspnPredictor;
  goalies?: EspnGoalies;
}

// Only these read as "up in the air" — a real game-time-decision — as
// opposed to a definite multi-week absence (an IL stint, IR, a season-ending
// injury). Checked by hand against MLB's IL-tiered statuses and this is
// deliberately a loose, cross-sport match rather than a fixed status list,
// since NFL/NBA/NHL each phrase this a little differently.
const GAME_TIME_DECISION_RE = /day-to-day|questionable|doubtful|probable|game-time/i;

function parseSignedNumber(s: string | undefined): number | null {
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

// Total lines come back as "o7.5"/"u7" — strip the leading over/under letter
// before parsing.
function parseTotalNumber(s: string | undefined): number | null {
  if (!s) return null;
  const n = parseFloat(s.replace(/^[ou]/i, ''));
  return Number.isNaN(n) ? null : n;
}

function statCategoryValue(categories: EspnStatCategory[] | undefined, name: string): string | null {
  return categories?.find((c) => c.name === name)?.displayValue ?? null;
}

function probablePitcherFor(competitors: EspnHeaderCompetitor[] | undefined, homeAway: 'home' | 'away') {
  const probable = competitors?.find((c) => c.homeAway === homeAway)?.probables?.[0];
  if (!probable?.athlete?.displayName) return null;
  const categories = probable.statistics?.splits?.categories;
  return {
    name: probable.athlete.displayName,
    throws: probable.athlete.throws?.abbreviation ?? null,
    wins: statCategoryValue(categories, 'wins'),
    losses: statCategoryValue(categories, 'losses'),
    era: statCategoryValue(categories, 'ERA'),
    strikeouts: statCategoryValue(categories, 'strikeouts'),
  };
}

function probableGoalieFor(goalies: EspnGoalies | undefined, homeAway: 'home' | 'away') {
  const athlete = (homeAway === 'home' ? goalies?.homeTeam : goalies?.awayTeam)?.athletes?.[0];
  if (!athlete?.displayName) return null;
  return {
    name: athlete.displayName,
    gaa: statCategoryValue(athlete.statistics, 'avgGoalsAgainst'),
    savePct: statCategoryValue(athlete.statistics, 'savePct'),
    wins: statCategoryValue(athlete.statistics, 'wins'),
    losses: statCategoryValue(athlete.statistics, 'losses'),
  };
}

function recentFormFor(lastFiveGames: EspnLastFiveTeam[] | undefined, teamId: string) {
  const events = lastFiveGames?.find((t) => t.team?.id === teamId)?.events ?? [];
  // ESPN returns these oldest-first — reverse so "most recent" reads first,
  // matching how Mike would scan a "last 5 games" list.
  const games: { date: string | null; opponent: string | null; atVs: string | null; result: 'W' | 'L' | null; score: string | null }[] = [...events]
    .reverse()
    .slice(0, 5)
    .map((e) => ({
      date: e.gameDate ?? null,
      opponent: e.opponent?.abbreviation ?? null,
      atVs: e.atVs ?? null,
      result: e.gameResult === 'W' || e.gameResult === 'L' ? e.gameResult : null,
      score: e.score ?? null,
    }));
  const wins = games.filter((g) => g.result === 'W').length;
  const losses = games.filter((g) => g.result === 'L').length;
  return { record: games.length > 0 ? `${wins}-${losses}` : null, games };
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
  probablePitcher: { name: string; throws: string | null; wins: string | null; losses: string | null; era: string | null; strikeouts: string | null } | null;
  probableGoalie: { name: string; gaa: string | null; savePct: string | null; wins: string | null; losses: string | null } | null;
  recentForm: { record: string | null; games: { date: string | null; opponent: string | null; atVs: string | null; result: 'W' | 'L' | null; score: string | null }[] };
}

async function fetchTeamSnapshot(
  sportPath: string,
  teamId: string,
  injuryEntry: EspnInjuryTeam | undefined,
  probablePitcher: TeamSnapshot['probablePitcher'],
  probableGoalie: TeamSnapshot['probableGoalie'],
  recentForm: TeamSnapshot['recentForm']
): Promise<TeamSnapshot | null> {
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
    // Only game-time-decision-ish statuses make it through — a definite
    // multi-week absence (10/15/60-day IL, IR, out for the season) isn't
    // useful for handicapping a single game the way "questionable" is.
    injuries: (injuryEntry?.injuries ?? [])
      .filter((inj) => GAME_TIME_DECISION_RE.test(inj.status ?? ''))
      .map((inj) => ({
        player: inj.athlete?.displayName ?? 'Unknown player',
        position: inj.athlete?.position?.abbreviation ?? null,
        status: inj.status ?? 'Unknown',
        detail: inj.details?.type ?? inj.details?.detail ?? null,
      })),
    topPerformers: [], // filled in by the caller once the abbreviation is known — see topPerformersFor below
    probablePitcher,
    probableGoalie,
    recentForm,
  };
}

betsEnrichmentRouter.get('/', async (c) => {
  const sport = (c.req.query('sport') ?? '').toUpperCase();
  const date = c.req.query('date') ?? ''; // 'YYYY-MM-DD'
  const matchup = c.req.query('matchup') ?? '';
  const sportPath = ESPN_SPORT_PATHS[sport];

  if (!sportPath || !date || !matchup) {
    return c.json({ found: false, venue: null, weather: null, odds: null, matchupHistory: null, predictor: null, home: null, away: null, note: 'Missing sport, date, or matchup.' });
  }

  const dateCompact = date.replace(/-/g, '');
  const resolved = await resolveEspnEvent(sportPath, dateCompact, matchup);
  if (!resolved) {
    return c.json({
      found: false,
      venue: null,
      weather: null,
      odds: null,
      matchupHistory: null,
      predictor: null,
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
  const headerCompetitors = summary?.header?.competitions?.[0]?.competitors;

  const [home, away] = await Promise.all([
    fetchTeamSnapshot(
      sportPath,
      resolved.homeTeamId,
      homeInjuries,
      probablePitcherFor(headerCompetitors, 'home'),
      probableGoalieFor(summary?.goalies, 'home'),
      recentFormFor(summary?.lastFiveGames, resolved.homeTeamId)
    ),
    fetchTeamSnapshot(
      sportPath,
      resolved.awayTeamId,
      awayInjuries,
      probablePitcherFor(headerCompetitors, 'away'),
      probableGoalieFor(summary?.goalies, 'away'),
      recentFormFor(summary?.lastFiveGames, resolved.awayTeamId)
    ),
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

  // Head-to-head history — prefer the full regular-season series (most
  // games, and the one Mike's own examples were about), falling back to
  // "current series" for a sport/date ESPN only has a short series for.
  const seasonSeries = summary?.seasonseries ?? [];
  const historyEntry = seasonSeries.find((s) => s.type === 'season') ?? seasonSeries.find((s) => s.type === 'current') ?? null;
  // A series in progress (like this week's) can carry not-yet-played games —
  // those have no real score, so they're dropped before slicing "last 5".
  const recentMeetings = [...(historyEntry?.events ?? [])]
    .filter((ev) => ev.status === 'post')
    .reverse()
    .slice(0, 5)
    .map((ev) => {
      const homeC = ev.competitors?.find((c) => c.homeAway === 'home');
      const awayC = ev.competitors?.find((c) => c.homeAway === 'away');
      return {
        date: ev.date ?? null,
        homeAbbr: homeC?.team?.abbreviation ?? null,
        awayAbbr: awayC?.team?.abbreviation ?? null,
        homeScore: homeC?.score ?? null,
        awayScore: awayC?.score ?? null,
        winnerAbbr: (homeC?.winner ? homeC?.team?.abbreviation : awayC?.winner ? awayC?.team?.abbreviation : null) ?? null,
      };
    });
  const matchupHistory =
    seasonSeries.length > 0
      ? {
          series: seasonSeries.map((s) => ({ type: s.type ?? '', summary: s.summary ?? null })),
          recentMeetings,
        }
      : null;

  const predictorInfo = summary?.predictor;
  const predictor =
    predictorInfo && (predictorInfo.homeTeam?.gameProjection != null || predictorInfo.awayTeam?.gameProjection != null)
      ? {
          homeWinPct: parseSignedNumber(predictorInfo.homeTeam?.gameProjection),
          awayWinPct: parseSignedNumber(predictorInfo.awayTeam?.gameProjection),
        }
      : null;

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
            windGust: weatherInfo.gust ?? null,
            indoor: !!indoor,
          }
        : null,
    odds: oddsInfo
      ? {
          provider: oddsInfo.provider?.name ?? null,
          spread: oddsInfo.pointSpread
            ? {
                home: { open: parseSignedNumber(oddsInfo.pointSpread.home?.open?.line), current: parseSignedNumber(oddsInfo.pointSpread.home?.close?.line) },
                away: { open: parseSignedNumber(oddsInfo.pointSpread.away?.open?.line), current: parseSignedNumber(oddsInfo.pointSpread.away?.close?.line) },
              }
            : null,
          total: oddsInfo.total
            ? {
                open: parseTotalNumber(oddsInfo.total.over?.open?.line),
                current: parseTotalNumber(oddsInfo.total.over?.close?.line),
                overOdds: parseSignedNumber(oddsInfo.total.over?.close?.odds),
                underOdds: parseSignedNumber(oddsInfo.total.under?.close?.odds),
              }
            : null,
          moneyline: oddsInfo.moneyline
            ? {
                home: { open: parseSignedNumber(oddsInfo.moneyline.home?.open?.odds), current: parseSignedNumber(oddsInfo.moneyline.home?.close?.odds) },
                away: { open: parseSignedNumber(oddsInfo.moneyline.away?.open?.odds), current: parseSignedNumber(oddsInfo.moneyline.away?.close?.odds) },
              }
            : null,
        }
      : null,
    matchupHistory,
    predictor,
    home,
    away,
    note: null,
  });
});

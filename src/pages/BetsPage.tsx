import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { type Bet, type BetOption, type BetPromo, type BetResult, type BetTransaction } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';
import type { Granularity } from '../utils/healthPeriods';
import {
  averageLegsPerParlay,
  buildBetPeriods,
  buildEquityCurve,
  byDayOfWeek,
  computeProfit,
  computeStreaks,
  favoriteUnderdogSplit,
  formatMoney,
  formatOdds,
  isMultiLegType,
  legSummary,
  groupByOddsRange,
  groupByTipper,
  overUnderHitRate,
  pickAccuracyByBetType,
  pickAccuracyBySport,
  resultLabel,
  sportsbookBalances,
  winRateByParlaySize,
  type AggregatedBetPeriod,
  type BetGroupStat,
  type PickAccuracyStat,
} from '../utils/bets';
import { ConfirmModal } from '../components/ConfirmModal';
import { Link, useSearchParams } from 'react-router-dom';
import { KebabMenu } from '../components/KebabMenu';
import { BetsBankingTab } from '../components/BetsBankingTab';
import { BetsPromosTab } from '../components/BetsPromosTab';
import { BetsWorkspaceTab } from '../components/BetsWorkspaceTab';
import { BetSlipModal, SettleBetModal } from '../components/BetSlip';

type BetsTab = 'workspace' | 'log' | 'performance' | 'trends' | 'banking' | 'promos';

const TABS: { id: BetsTab; label: string }[] = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'log', label: 'Log' },
  { id: 'performance', label: 'Performance' },
  { id: 'trends', label: 'Trends' },
  { id: 'banking', label: 'Banking' },
  { id: 'promos', label: 'Promos' },
];

const GRANULARITIES: { id: Granularity; label: string }[] = [
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'quarter', label: 'Quarter' },
  { id: 'year', label: 'Year' },
];

function ResultBadge({ result }: { result: BetResult }) {
  return <span className={`bets__result-badge bets__result-badge--${result}`}>{resultLabel(result)}</span>;
}

function Tile({ label, value, aside }: { label: string; value: string | null; aside?: string | null }) {
  return (
    <div className="dashboard-page__tile card">
      <div className="dashboard-page__tile-label">{label}</div>
      <div className="dashboard-page__tile-value">{value ?? <span className="dashboard-page__tile-nodata">No data</span>}</div>
      {aside && <div className="dashboard-page__tile-aside">{aside}</div>}
    </div>
  );
}

/** "Performance by sport / bet type / sportsbook / odds range" — sorted
 * best-net-first (or, for odds ranges, favorite→underdog order — see
 * groupByOddsRange). */
function MoneyBreakdownTable({ title, rows }: { title: string; rows: BetGroupStat[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="bets-breakdown card">
      <div className="bets-breakdown__title">{title}</div>
      <div className="bets-breakdown__row bets-breakdown__row--head">
        <span>Name</span>
        <span>Bets</span>
        <span>Risked</span>
        <span>Net</span>
        <span>Win rate</span>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="bets-breakdown__row">
          <span className="bets-breakdown__name">{r.key}</span>
          <span>{r.count}</span>
          <span>{formatMoney(r.risked)}</span>
          <span className={`bets-breakdown__net ${r.net >= 0 ? 'is-up' : 'is-down'}`}>{formatMoney(r.net)}</span>
          <span>{r.winRate != null ? `${Math.round(r.winRate * 100)}%` : '—'}</span>
        </div>
      ))}
    </div>
  );
}

/** Pick-accuracy version of the table above — no money columns, since a
 * pick (a parlay leg included) doesn't have its own wager/payout, only a
 * result. See utils/bets.ts's Pick-accuracy section for why this is a
 * separate question from the money breakdowns. */
function PickAccuracyTable({ title, rows }: { title: string; rows: PickAccuracyStat[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="bets-breakdown card">
      <div className="bets-breakdown__title">{title}</div>
      <div className="bets-breakdown__row bets-breakdown__row--head">
        <span>Name</span>
        <span>Record</span>
        <span />
        <span>Win rate</span>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="bets-breakdown__row">
          <span className="bets-breakdown__name">{r.key}</span>
          <span>
            {r.wins}-{r.losses}
            {r.pushes ? `-${r.pushes}p` : ''}
          </span>
          <span />
          <span>{r.winRate != null ? `${Math.round(r.winRate * 100)}%` : '—'}</span>
        </div>
      ))}
    </div>
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

type DayStat = { net: number; risked: number; wins: number; losses: number; draws: number; pending: number; count: number };

/** Per-day totals for the Log calendar. Record is W-L-D where a push is a
 * draw; void / cashed-out don't count toward the record, TBD is "pending". */
function dayStats(bets: Bet[]): Map<string, DayStat> {
  const map = new Map<string, DayStat>();
  for (const bet of bets) {
    const s = map.get(bet.date) ?? { net: 0, risked: 0, wins: 0, losses: 0, draws: 0, pending: 0, count: 0 };
    s.net += computeProfit(bet);
    s.risked += bet.wager;
    s.count += 1;
    if (bet.result === 'win') s.wins += 1;
    else if (bet.result === 'loss') s.losses += 1;
    else if (bet.result === 'push') s.draws += 1;
    else if (bet.result === 'tbd') s.pending += 1;
    map.set(bet.date, s);
  }
  return map;
}

function recordLabel(s: DayStat): string {
  return `${s.wins}-${s.losses}-${s.draws}`;
}

/** Month grid, color-coded by that day's net (deeper green/red the bigger
 * the swing, relative to the month's own biggest day) — the "profit
 * calendar" idea pulled from real competing apps (Bet Journal). Each day
 * shows its net and W-L-D record; clicking a day opens that day's bets. */
function ProfitCalendar({ stats, selected, onSelect }: { stats: Map<string, DayStat>; selected: string | null; onSelect: (date: string | null) => void }) {
  const [monthCursor, setMonthCursor] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  const maxAbs = Math.max(1, ...[...stats.values()].map((v) => Math.abs(v.net)));
  const first = new Date(monthCursor.y, monthCursor.m, 1);
  const daysInMonth = new Date(monthCursor.y, monthCursor.m + 1, 0).getDate();
  const leadingBlanks = first.getDay();
  const cells: (string | null)[] = [...Array(leadingBlanks).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => `${monthCursor.y}-${pad2(monthCursor.m + 1)}-${pad2(i + 1)}`)];
  const monthPrefix = `${monthCursor.y}-${pad2(monthCursor.m + 1)}-`;
  const monthDays = [...stats.entries()].filter(([d]) => d.startsWith(monthPrefix)).map(([, s]) => s);
  const monthTotal = monthDays.reduce(
    (acc, s) => ({ net: acc.net + s.net, risked: 0, wins: acc.wins + s.wins, losses: acc.losses + s.losses, draws: acc.draws + s.draws, pending: 0, count: 0 }),
    { net: 0, risked: 0, wins: 0, losses: 0, draws: 0, pending: 0, count: 0 } as DayStat
  );

  return (
    <div className="bets-calendar card">
      <div className="bets-calendar__header">
        <button type="button" className="dashboard-page__nav-btn" onClick={() => setMonthCursor(({ y, m }) => (m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 }))} aria-label="Previous month">
          ‹
        </button>
        <span>{first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</span>
        <button type="button" className="dashboard-page__nav-btn" onClick={() => setMonthCursor(({ y, m }) => (m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 }))} aria-label="Next month">
          ›
        </button>
      </div>
      {monthDays.length > 0 && (
        <div className="bets-calendar__month-summary">
          <span>{recordLabel(monthTotal)}</span>
          <span className={monthTotal.net >= 0 ? 'is-up' : 'is-down'}>{formatMoney(monthTotal.net)}</span>
        </div>
      )}
      <div className="bets-calendar__weekdays">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      <div className="bets-calendar__grid">
        {cells.map((date, i) => {
          if (!date) return <div key={i} className="bets-calendar__cell bets-calendar__cell--blank" />;
          const s = stats.get(date);
          const intensity = s ? Math.min(1, Math.abs(s.net) / maxAbs) : 0;
          const bg = !s ? undefined : s.net >= 0 ? `rgba(46, 139, 87, ${0.12 + intensity * 0.55})` : `rgba(192, 57, 43, ${0.12 + intensity * 0.55})`;
          return (
            <button
              key={i}
              type="button"
              className={`bets-calendar__cell${selected === date ? ' is-selected' : ''}${!s ? ' is-empty' : ''}`}
              style={bg ? { background: bg } : undefined}
              onClick={() => onSelect(selected === date ? null : date)}
              disabled={!s}
              title={s ? `${date}: ${recordLabel(s)}, ${formatMoney(s.net)}` : date}
            >
              <span className="bets-calendar__daynum">{Number(date.slice(-2))}</span>
              {s && <span className="bets-calendar__net">{formatMoney(s.net)}</span>}
              {s && <span className="bets-calendar__record">{recordLabel(s)}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BetRow({ bet, showDate, onEdit, onDelete, onSettle }: { bet: Bet; showDate: boolean; onEdit: (b: Bet) => void; onDelete: (b: Bet) => void; onSettle: (b: Bet) => void }) {
  const profit = computeProfit(bet);
  const multi = isMultiLegType(bet.bet_type) && bet.legs.length > 0;
  const title = multi ? `${bet.legs.length}-Leg ${bet.bet_type}` : bet.legs[0] ? legSummary(bet.legs[0]) : bet.pick || `${bet.sport} ${bet.bet_type}`;
  return (
    <div className="bets-log__row">
      <div className="bets-log__main">
        {showDate && <span className="bets-log__date">{bet.date}</span>}
        <span className="bets-log__pick">{title}</span>
        <span className="bets-log__meta">
          {bet.sport} · {bet.sportsbook} · {formatOdds(bet.odds)} · {formatMoney(bet.wager)}
          {bet.stake_type === 'free_bet' && <span className="bets-log__freebet"> · Free bet</span>}
        </span>
        {multi && (
          <span className="bets-log__legs">
            {bet.legs.map((l, i) => (
              <span key={l.id} className={`bets-log__leg is-${l.result}`}>
                {i > 0 ? ' · ' : ''}
                {legSummary(l)}
              </span>
            ))}
          </span>
        )}
      </div>
      {bet.result === 'tbd' ? (
        <button type="button" className="chip bets-log__settle" onClick={() => onSettle(bet)}>
          Settle
        </button>
      ) : (
        <ResultBadge result={bet.result} />
      )}
      <span className={`bets-log__profit ${profit >= 0 ? 'is-up' : 'is-down'}`}>{bet.result === 'tbd' ? '—' : formatMoney(profit)}</span>
      <KebabMenu
        items={[
          ...(bet.result === 'tbd' ? [] : [{ label: 'Change Result', onClick: () => onSettle(bet) }]),
          { label: 'Edit', onClick: () => onEdit(bet) },
          { label: 'Delete', onClick: () => onDelete(bet), danger: true, separatorBefore: true },
        ]}
      />
    </div>
  );
}

/** The clicked day: its record, net and amount risked, then every bet made
 * that day with how it did. */
function BetsDayDetail({ date, stat, bets, onClose, onEdit, onDelete, onSettle }: { date: string; stat: DayStat; bets: Bet[]; onClose: () => void; onEdit: (b: Bet) => void; onDelete: (b: Bet) => void; onSettle: (b: Bet) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [date]);
  const label = new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  return (
    <div className="bets-day card" ref={ref}>
      <div className="bets-day__header">
        <span className="bets-day__title">{label}</span>
        <button type="button" className="chip" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="bets-day__stats">
        <div>
          <span className="bets-day__stat-label">Record (W-L-D)</span>
          <span className="bets-day__stat-value">{recordLabel(stat)}</span>
        </div>
        <div>
          <span className="bets-day__stat-label">Won / Lost</span>
          <span className={`bets-day__stat-value ${stat.net >= 0 ? 'is-up' : 'is-down'}`}>{formatMoney(stat.net)}</span>
        </div>
        <div>
          <span className="bets-day__stat-label">Risked</span>
          <span className="bets-day__stat-value">{formatMoney(stat.risked)}</span>
        </div>
        <div>
          <span className="bets-day__stat-label">Bets</span>
          <span className="bets-day__stat-value">
            {stat.count}
            {stat.pending > 0 && <span className="bets-day__pending"> ({stat.pending} pending)</span>}
          </span>
        </div>
      </div>
      <div className="bets-day__list">
        {bets.map((bet) => (
          <BetRow key={bet.id} bet={bet} showDate={false} onEdit={onEdit} onDelete={onDelete} onSettle={onSettle} />
        ))}
      </div>
    </div>
  );
}

function LogTab({ bets, onEdit, onDelete, onSettle }: { bets: Bet[]; onEdit: (b: Bet) => void; onDelete: (b: Bet) => void; onSettle: (b: Bet) => void }) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const stats = useMemo(() => dayStats(bets), [bets]);
  const selectedStat = selectedDate ? stats.get(selectedDate) : undefined;
  const dayBets = useMemo(() => (selectedDate ? bets.filter((b) => b.date === selectedDate) : []), [bets, selectedDate]);

  const filtered = useMemo(() => {
    let list = bets;
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((b) =>
        [b.sport, b.sportsbook, b.bet_type, b.pick, b.notes, ...b.legs.map((l) => l.pick)].filter(Boolean).some((s) => String(s).toLowerCase().includes(q))
      );
    }
    return [...list].sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [bets, query]);

  return (
    <div>
      <ProfitCalendar stats={stats} selected={selectedDate} onSelect={setSelectedDate} />

      {selectedDate && selectedStat && (
        <BetsDayDetail date={selectedDate} stat={selectedStat} bets={dayBets} onClose={() => setSelectedDate(null)} onEdit={onEdit} onDelete={onDelete} onSettle={onSettle} />
      )}

      <div className="toolbar-row" style={{ marginTop: 16 }}>
        <input className="bets-log__search" placeholder="Search picks, sportsbooks, notes…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">No bets match.</div>
      ) : (
        <div className="bets-log card">
          {filtered.map((bet) => (
            <BetRow key={bet.id} bet={bet} showDate onEdit={onEdit} onDelete={onDelete} onSettle={onSettle} />
          ))}
        </div>
      )}
    </div>
  );
}

function PerformanceTab({ bets }: { bets: Bet[] }) {
  const [granularity, setGranularity] = useState<Granularity>('month');
  const [periodIndex, setPeriodIndex] = useState<number>(-1);

  const periods = useMemo(() => buildBetPeriods(bets, granularity), [bets, granularity]);
  const activeIndex = periodIndex >= 0 && periodIndex < periods.length ? periodIndex : periods.length - 1;
  const current: AggregatedBetPeriod | null = periods[activeIndex] ?? null;

  function changeGranularity(g: Granularity) {
    setGranularity(g);
    setPeriodIndex(-1);
  }

  const { over, under } = overUnderHitRate(current?.bets ?? bets);
  const oddsRanges = groupByOddsRange(current?.bets ?? bets);

  return (
    <div>
      <div className="dashboard-page__controls">
        <div className="dashboard-page__granularity-tabs">
          {GRANULARITIES.map((g) => (
            <button key={g.id} type="button" className={`dashboard-page__tab${granularity === g.id ? ' is-active' : ''}`} onClick={() => changeGranularity(g.id)}>
              {g.label}
            </button>
          ))}
        </div>
        {current && (
          <div className="dashboard-page__period-nav">
            <div className="dashboard-page__period-pill">
              <button type="button" className="dashboard-page__nav-btn" disabled={activeIndex <= 0} onClick={() => setPeriodIndex(activeIndex - 1)} aria-label="Previous period">
                ‹
              </button>
              <span className="dashboard-page__period-label">
                <span className="dashboard-page__period-main">{current.label}</span>
                <span className="dashboard-page__period-sublabel">{current.bets.length} bets</span>
              </span>
              <button
                type="button"
                className="dashboard-page__nav-btn"
                disabled={activeIndex >= periods.length - 1}
                onClick={() => setPeriodIndex(activeIndex + 1)}
                aria-label="Next period"
              >
                ›
              </button>
            </div>
            {activeIndex < periods.length - 1 && (
              <button type="button" className="chip" onClick={() => setPeriodIndex(-1)}>
                Jump to latest
              </button>
            )}
          </div>
        )}
      </div>

      {current && (
        <div className="dashboard-page__tiles">
          <Tile label="Risked" value={formatMoney(current.risked)} />
          <Tile label="Net" value={formatMoney(current.net)} />
          <Tile label="ROI" value={current.roi != null ? `${(current.roi * 100).toFixed(1)}%` : null} />
          <Tile label="Win Rate" value={current.winRate != null ? `${Math.round(current.winRate * 100)}%` : null} aside={`${current.wins}-${current.losses}${current.pushes ? `-${current.pushes}p` : ''}`} />
        </div>
      )}

      {current && (
        <div className="bets-breakdowns">
          <MoneyBreakdownTable title="By sport" rows={current.bySport} />
          <MoneyBreakdownTable title="By bet type" rows={current.byBetType} />
          <MoneyBreakdownTable title="By sportsbook" rows={current.bySportsbook} />
          <MoneyBreakdownTable title="By odds range" rows={oddsRanges} />
          <MoneyBreakdownTable title="By tipper" rows={groupByTipper(current?.bets ?? bets)} />
        </div>
      )}

      <div className="bets-breakdowns">
        <PickAccuracyTable title="Pick accuracy by sport" rows={pickAccuracyBySport(current?.bets ?? bets)} />
        <PickAccuracyTable title="Pick accuracy by bet type" rows={pickAccuracyByBetType(current?.bets ?? bets)} />
        <PickAccuracyTable title="Over / Under" rows={[over, under].filter((r) => r.wins + r.losses + r.pushes + r.voids > 0)} />
      </div>
    </div>
  );
}

function EquityChart({ points }: { points: { date: string; cumulative: number }[] }) {
  if (points.length < 2) return null;
  const values = points.map((p) => p.cumulative);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const range = max - min || 1;
  const w = 100;
  const h = 32;
  const step = w / (points.length - 1);
  const coords = points.map((p, i) => `${i * step},${h - ((p.cumulative - min) / range) * (h - 4) - 2}`);
  const zeroY = h - ((0 - min) / range) * (h - 4) - 2;
  return (
    <svg className="bets-equity__chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <line x1="0" y1={zeroY} x2={w} y2={zeroY} stroke="currentColor" strokeOpacity="0.2" strokeWidth="0.5" />
      <polyline points={coords.join(' ')} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrendsTab({ bets }: { bets: Bet[] }) {
  const sorted = useMemo(() => [...bets].sort((a, b) => (a.date < b.date ? -1 : 1)), [bets]);
  const streaks = useMemo(() => computeStreaks(sorted), [sorted]);
  const dow = useMemo(() => byDayOfWeek(bets), [bets]);
  const { favorites, underdogs } = useMemo(() => favoriteUnderdogSplit(bets), [bets]);
  const equity = useMemo(() => buildEquityCurve(bets), [bets]);
  const parlaySizes = useMemo(() => winRateByParlaySize(bets), [bets]);
  const avgLegs = useMemo(() => averageLegsPerParlay(bets), [bets]);

  return (
    <div>
      <div className="dashboard-page__tiles">
        <Tile
          label="Current streak"
          value={streaks.currentType ? `${streaks.currentLength} ${streaks.currentType === 'win' ? 'wins' : 'losses'}` : null}
        />
        <Tile label="Longest win streak" value={streaks.longestWin > 0 ? `${streaks.longestWin}` : null} />
        <Tile label="Longest loss streak" value={streaks.longestLoss > 0 ? `${streaks.longestLoss}` : null} />
        <Tile label="Avg. legs per parlay" value={avgLegs != null ? avgLegs.toFixed(1) : null} />
      </div>

      {equity.length > 1 && (
        <div className="bets-equity card">
          <div className="bets-breakdown__title">Bankroll equity curve</div>
          <EquityChart points={equity} />
          <div className="bets-equity__endpoints">
            <span>{equity[0].date}</span>
            <span className={equity[equity.length - 1].cumulative >= 0 ? 'is-up' : 'is-down'}>{formatMoney(equity[equity.length - 1].cumulative)}</span>
          </div>
        </div>
      )}

      <div className="bets-breakdowns">
        <MoneyBreakdownTable title="By day of week" rows={dow.filter((d) => d.count > 0)} />
        <MoneyBreakdownTable title="Favorites vs. underdogs" rows={[favorites, underdogs].filter((r) => r.count > 0)} />
        <PickAccuracyTable title="Win rate by parlay size" rows={parlaySizes} />
      </div>
    </div>
  );
}

export function BetsPage() {
  useReportTabMeta('Bets', 'bets');
  const [bets, setBets] = useState<Bet[] | null>(null);
  const [transactions, setTransactions] = useState<BetTransaction[] | null>(null);
  const [promos, setPromos] = useState<BetPromo[] | null>(null);
  const [betOptions, setBetOptions] = useState<BetOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  // ?tab=promos (etc.) deep-links straight to a tab — Today's Free Bet rows use it.
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get('tab') as BetsTab | null;
  const [tab, setTab] = useState<BetsTab>(initialTab && TABS.some((t) => t.id === initialTab) ? initialTab : 'workspace');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Bet | null>(null);
  const [deleting, setDeleting] = useState<Bet | null>(null);
  const [settling, setSettling] = useState<Bet | null>(null);

  const load = () =>
    Promise.all([api.listBets(), api.listBetTransactions(), api.listBetPromos(), api.listBetOptions()])
      .then(([b, t, p, o]) => {
        setBets(b);
        setTransactions(t);
        setPromos(p);
        setBetOptions(o);
      })
      .catch((e) => setError(String(e)));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate(params: Record<string, unknown>) {
    await api.createBet(params as Parameters<typeof api.createBet>[0]);
    setAdding(false);
    load();
  }

  async function handleUpdate(params: Record<string, unknown>) {
    if (!editing) return;
    await api.updateBet(editing.id, params);
    setEditing(null);
    load();
  }

  async function handleSettle(params: Record<string, unknown>) {
    if (!settling) return;
    await api.updateBet(settling.id, params);
    setSettling(null);
    load();
  }

  async function handleDelete(bet: Bet) {
    setBets((prev) => (prev ? prev.filter((b) => b.id !== bet.id) : prev));
    await api.deleteBet(bet.id);
    setDeleting(null);
  }

  async function handleCreateTransaction(params: Record<string, unknown>) {
    const created = await api.createBetTransaction(params as Parameters<typeof api.createBetTransaction>[0]);
    setTransactions((prev) => (prev ? [created, ...prev] : [created]));
  }

  async function handleUpdateTransaction(id: string, params: Record<string, unknown>) {
    const updated = await api.updateBetTransaction(id, params);
    setTransactions((prev) => (prev ? prev.map((t) => (t.id === id ? updated : t)) : prev));
  }

  async function handleDeleteTransaction(t: BetTransaction) {
    setTransactions((prev) => (prev ? prev.filter((x) => x.id !== t.id) : prev));
    await api.deleteBetTransaction(t.id);
  }

  async function handleCreatePromo(params: Record<string, unknown>) {
    const created = await api.createBetPromo(params as Parameters<typeof api.createBetPromo>[0]);
    setPromos((prev) => (prev ? [created, ...prev] : [created]));
  }

  async function handleUpdatePromo(id: string, params: Record<string, unknown>) {
    const updated = await api.updateBetPromo(id, params);
    setPromos((prev) => (prev ? prev.map((p) => (p.id === id ? updated : p)) : prev));
  }

  async function handleDeletePromo(p: BetPromo) {
    setPromos((prev) => (prev ? prev.filter((x) => x.id !== p.id) : prev));
    await api.deleteBetPromo(p.id);
  }

  if (error) return <div className="empty-state">Couldn't load bets: {error}</div>;
  if (!bets || !transactions || !promos) return <div className="empty-state">Loading…</div>;

  const balances = sportsbookBalances(bets, transactions);
  // Most-used books first on the slip's sportsbook chips.
  const bookCounts = new Map<string, number>();
  for (const b of bets) bookCounts.set(b.sportsbook, (bookCounts.get(b.sportsbook) ?? 0) + 1);
  const recentBooks = [...bookCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);

  return (
    <div>
      <div className="toolbar-row">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
          Bets
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* Bet options + balances live in Settings → Bets now (see
              settings/BetOptionsPanel) — this is just the deep link over,
              same as News' gear. */}
          <Link to="/settings?cat=bets" className="settings-gear-link" title="Bets Settings" aria-label="Bets Settings">
            ⚙️
          </Link>
          <button className="btn" onClick={() => setAdding(true)}>
            + Log a Bet
          </button>
        </div>
      </div>

      <div className="dashboard-page__granularity-tabs" style={{ marginBottom: 16 }}>
        {TABS.map((t) => (
          <button key={t.id} type="button" className={`dashboard-page__tab${tab === t.id ? ' is-active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'workspace' && <BetsWorkspaceTab balances={balances} promos={promos} />}
      {tab === 'log' &&
        (bets.length === 0 ? (
          <div className="empty-state">No bets logged yet — log one the day after you make it: sport, sportsbook, odds, wager, and the result.</div>
        ) : (
          <LogTab bets={bets} onEdit={setEditing} onDelete={setDeleting} onSettle={setSettling} />
        ))}
      {tab === 'performance' &&
        (bets.length === 0 ? <div className="empty-state">No bets logged yet.</div> : <PerformanceTab bets={bets} />)}
      {tab === 'trends' && (bets.length === 0 ? <div className="empty-state">No bets logged yet.</div> : <TrendsTab bets={bets} />)}
      {tab === 'banking' && (
        <BetsBankingTab bets={bets} transactions={transactions} onCreate={handleCreateTransaction} onUpdate={handleUpdateTransaction} onDelete={handleDeleteTransaction} />
      )}
      {tab === 'promos' && <BetsPromosTab promos={promos} onCreate={handleCreatePromo} onUpdate={handleUpdatePromo} onDelete={handleDeletePromo} />}

      {adding && <BetSlipModal bet={null} betOptions={betOptions} recentBooks={recentBooks} onClose={() => setAdding(false)} onSave={handleCreate} />}
      {editing && <BetSlipModal bet={editing} betOptions={betOptions} recentBooks={recentBooks} onClose={() => setEditing(null)} onSave={handleUpdate} />}
      {settling && <SettleBetModal bet={settling} betOptions={betOptions} onClose={() => setSettling(null)} onSave={handleSettle} />}
      {deleting && (
        <ConfirmModal
          title="Delete bet?"
          body={`This ${deleting.date} ${deleting.sport} bet will be permanently deleted.`}
          onConfirm={() => handleDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

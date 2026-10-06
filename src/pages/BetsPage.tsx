import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { BET_STAKE_TYPES, type Bet, type BetLeg, type BetOption, type BetPromo, type BetResult, type BetStakeType, type BetTransaction } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';
import type { Granularity } from '../utils/healthPeriods';
import {
  BET_TYPES,
  COMMON_SPORTSBOOKS,
  LEG_RESULT_OPTIONS,
  SPORTS,
  averageLegsPerParlay,
  buildBetPeriods,
  buildEquityCurve,
  byDayOfWeek,
  computeProfit,
  computeStreaks,
  favoriteUnderdogSplit,
  formatMoney,
  formatOdds,
  groupByOddsRange,
  groupByTipper,
  isParlayType,
  legBetTypes,
  optionLabel,
  optionValues,
  overUnderHitRate,
  pickAccuracyByBetType,
  pickAccuracyBySport,
  resultLabel,
  sportsbookBalances,
  withCurrentValue,
  yesterdayLocalISODash,
  winRateByParlaySize,
  type AggregatedBetPeriod,
  type BetGroupStat,
  type PickAccuracyStat,
} from '../utils/bets';
import { Modal } from '../components/Modal';
import { ConfirmModal } from '../components/ConfirmModal';
import { Link } from 'react-router-dom';
import { KebabMenu } from '../components/KebabMenu';
import { BetsBankingTab } from '../components/BetsBankingTab';
import { BetsPromosTab } from '../components/BetsPromosTab';
import { BetsWorkspaceTab } from '../components/BetsWorkspaceTab';

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

type LegDraft = { sport: string; bet_type: string; pick: string; line: string; over_under: '' | 'over' | 'under'; odds: string; result: BetResult };

function emptyLegDraft(legTypes: string[]): LegDraft {
  return { sport: SPORTS[0], bet_type: legTypes[0] ?? '', pick: '', line: '', over_under: '', odds: '', result: 'win' };
}

function legDraftFromLeg(leg: BetLeg): LegDraft {
  return {
    sport: leg.sport,
    bet_type: leg.bet_type,
    pick: leg.pick ?? '',
    line: leg.line != null ? String(leg.line) : '',
    over_under: leg.over_under ?? '',
    odds: leg.odds != null ? String(leg.odds) : '',
    result: leg.result,
  };
}

/** Add/edit form for a single bet. Straight bets keep the simple
 * pick+odds+result flow; Parlay/SGP/SGPx swap the single Pick
 * field for a repeatable leg builder — the bet's own Odds field still
 * holds the parlay's combined price, wager and result still live at the
 * bet level (see 0038_bet_legs.sql's header for why). */
function BetFormModal({ bet, betOptions, onClose, onSave }: { bet: Bet | null; betOptions: BetOption[]; onClose: () => void; onSave: (params: Record<string, unknown>) => Promise<void> }) {
  const betTypeOptions = withCurrentValue(optionValues(betOptions, 'bet_type'), bet?.bet_type);
  const resultOptions = withCurrentValue(optionValues(betOptions, 'result'), bet?.result);
  const lineOptions = withCurrentValue(optionValues(betOptions, 'line'), bet?.line);
  const tipperOptions = optionValues(betOptions, 'tipper');
  const legTypeOptions = legBetTypes(betTypeOptions.length > 0 ? betTypeOptions : BET_TYPES);

  const [date, setDate] = useState(bet?.date ?? yesterdayLocalISODash());
  const [sport, setSport] = useState(bet?.sport ?? SPORTS[0]);
  const [sportsbook, setSportsbook] = useState(bet?.sportsbook ?? '');
  const [betType, setBetType] = useState(bet?.bet_type ?? betTypeOptions[0] ?? BET_TYPES[0]);
  const [tipper, setTipper] = useState(bet?.tipper ?? '');
  const [line, setLine] = useState(bet?.line ?? '');
  const [odds, setOdds] = useState(bet ? String(bet.odds) : '');
  const [wager, setWager] = useState(bet ? String(bet.wager) : '');
  const [result, setResult] = useState<BetResult>(bet?.result ?? resultOptions[0] ?? 'win');
  const [stakeType, setStakeType] = useState<BetStakeType>(bet?.stake_type ?? 'cash');
  const [notes, setNotes] = useState(bet?.notes ?? '');
  const [showOverride, setShowOverride] = useState(bet?.manual_profit != null);
  const [manualProfit, setManualProfit] = useState(bet?.manual_profit != null ? String(bet.manual_profit) : '');
  const [legs, setLegs] = useState<LegDraft[]>(bet && bet.legs.length > 0 ? bet.legs.map(legDraftFromLeg) : [emptyLegDraft(legTypeOptions), emptyLegDraft(legTypeOptions)]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parlay = isParlayType(betType);

  const oddsNum = Number(odds);
  const wagerNum = Number(wager);
  const previewProfit =
    Number.isFinite(oddsNum) && oddsNum !== 0 && Number.isFinite(wagerNum) && wagerNum > 0
      ? computeProfit({
          odds: oddsNum,
          wager: wagerNum,
          result,
          stake_type: stakeType,
          manual_profit: showOverride && manualProfit !== '' ? Number(manualProfit) : null,
        } as Bet)
      : null;

  function updateLeg(i: number, patch: Partial<LegDraft>) {
    setLegs((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function addLeg() {
    setLegs((prev) => [...prev, emptyLegDraft(legTypeOptions)]);
  }
  function removeLeg(i: number) {
    setLegs((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function handleSave() {
    if (!sportsbook.trim()) return setError('Sportsbook is required.');
    if (!Number.isFinite(oddsNum) || oddsNum === 0) return setError('Odds must be a non-zero number, e.g. -110 or 150.');
    if (!Number.isFinite(wagerNum) || wagerNum <= 0) return setError('Wager must be a positive number.');
    let legsPayload: Record<string, unknown>[] | undefined;
    if (parlay) {
      if (legs.length < 2) return setError('A parlay needs at least two legs.');
      for (const l of legs) {
        if (!l.sport || !l.bet_type) return setError('Every leg needs a sport and bet type.');
      }
      legsPayload = legs.map((l) => ({
        sport: l.sport,
        bet_type: l.bet_type,
        pick: l.pick.trim() || null,
        line: l.line.trim() !== '' ? Number(l.line) : null,
        over_under: l.over_under || null,
        odds: l.odds.trim() !== '' ? Number(l.odds) : null,
        result: l.result,
      }));
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        date,
        sport,
        sportsbook: sportsbook.trim(),
        bet_type: betType,
        tipper: tipper.trim() || undefined,
        line: parlay ? undefined : line || undefined,
        odds: oddsNum,
        wager: wagerNum,
        result,
        stake_type: stakeType,
        manual_profit: showOverride && manualProfit !== '' ? Number(manualProfit) : null,
        notes: notes.trim() || undefined,
        legs: legsPayload,
      });
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  return (
    <Modal title={bet ? 'Edit Bet' : 'Log a Bet'} onClose={onClose}>
      <div className="bets-form">
        <label className="bets-form__field">
          <span>Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="bets-form__field">
          <span>Sport</span>
          <select value={sport} onChange={(e) => setSport(e.target.value)}>
            {SPORTS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="bets-form__field">
          <span>Sportsbook</span>
          <input list="bets-sportsbooks" placeholder="DraftKings" value={sportsbook} onChange={(e) => setSportsbook(e.target.value)} />
          <datalist id="bets-sportsbooks">
            {COMMON_SPORTSBOOKS.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </label>
        <label className="bets-form__field">
          <span>Bet type</span>
          <select value={betType} onChange={(e) => setBetType(e.target.value)}>
            {betTypeOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="bets-form__field">
          <span>Tipper (optional)</span>
          <input list="bets-tippers" placeholder="Who's the pick from?" value={tipper} onChange={(e) => setTipper(e.target.value)} />
          <datalist id="bets-tippers">
            {tipperOptions.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>

        {!parlay && (
          <label className="bets-form__field">
            <span>Line (optional)</span>
            <select value={line} onChange={(e) => setLine(e.target.value)}>
              <option value="">—</option>
              {lineOptions.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            {bet?.pick && <span className="bets-form__hint">Previously logged as "{bet.pick}" — kept for reference, no longer edited here.</span>}
          </label>
        )}

        <div className="bets-form__row">
          <label className="bets-form__field">
            <span>{parlay ? 'Combined odds (American)' : 'Odds (American)'}</span>
            <input placeholder="-110" value={odds} onChange={(e) => setOdds(e.target.value)} />
          </label>
          <label className="bets-form__field">
            <span>Wager</span>
            <input placeholder="25" inputMode="decimal" value={wager} onChange={(e) => setWager(e.target.value)} />
          </label>
        </div>
        <label className="bets-form__field">
          <span>Funded with</span>
          <select value={stakeType} onChange={(e) => setStakeType(e.target.value as BetStakeType)}>
            {BET_STAKE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          {stakeType === 'free_bet' && (
            <span className="bets-form__hint">A loss here won't be counted against your real balance — the stake wasn't your cash. A win still pays out normally (stake not returned, same as the sportsbook's own rule).</span>
          )}
        </label>
        <label className="bets-form__field">
          <span>Result</span>
          <select value={result} onChange={(e) => setResult(e.target.value as BetResult)}>
            {resultOptions.map((r) => (
              <option key={r} value={r}>
                {optionLabel(betOptions, 'result', r) !== r ? optionLabel(betOptions, 'result', r) : resultLabel(r)}
              </option>
            ))}
          </select>
        </label>

        {parlay && (
          <div className="bets-legs">
            <div className="bets-legs__title">Legs</div>
            {legs.map((leg, i) => (
              <div key={i} className="bets-legs__row">
                <select value={leg.sport} onChange={(e) => updateLeg(i, { sport: e.target.value })}>
                  {SPORTS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <select value={leg.bet_type} onChange={(e) => updateLeg(i, { bet_type: e.target.value })}>
                  {withCurrentValue(legTypeOptions, leg.bet_type).map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <input className="bets-legs__pick" placeholder="Mahomes o275.5 pass yds" value={leg.pick} onChange={(e) => updateLeg(i, { pick: e.target.value })} />
                <input className="bets-legs__line" placeholder="Line" inputMode="decimal" value={leg.line} onChange={(e) => updateLeg(i, { line: e.target.value })} />
                <select value={leg.over_under} onChange={(e) => updateLeg(i, { over_under: e.target.value as LegDraft['over_under'] })}>
                  <option value="">O/U</option>
                  <option value="over">Over</option>
                  <option value="under">Under</option>
                </select>
                <input className="bets-legs__odds" placeholder="Odds" value={leg.odds} onChange={(e) => updateLeg(i, { odds: e.target.value })} />
                <select value={leg.result} onChange={(e) => updateLeg(i, { result: e.target.value as BetResult })}>
                  {LEG_RESULT_OPTIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <button type="button" className="bets-legs__remove" onClick={() => removeLeg(i)} disabled={legs.length <= 2} aria-label="Remove leg">
                  ✕
                </button>
              </div>
            ))}
            <button type="button" className="link-btn" onClick={() => addLeg()}>
              + Add leg
            </button>
          </div>
        )}

        {previewProfit != null && (
          <div className={`bets-form__preview ${previewProfit >= 0 ? 'is-up' : 'is-down'}`}>
            {previewProfit >= 0 ? 'Profit' : 'Loss'}: {formatMoney(previewProfit)}
          </div>
        )}

        {!showOverride ? (
          <button type="button" className="link-btn" onClick={() => setShowOverride(true)}>
            Override calculated profit (boost, free bet, partial void…)
          </button>
        ) : (
          <label className="bets-form__field">
            <span>Actual profit/loss (overrides the calculation above)</span>
            <input placeholder="e.g. 37.50 or -25" inputMode="decimal" value={manualProfit} onChange={(e) => setManualProfit(e.target.value)} />
          </label>
        )}

        <label className="bets-form__field">
          <span>Notes (optional)</span>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        {error && <div className="bets-form__error">{error}</div>}
      </div>
      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button className="btn" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : bet ? 'Save' : 'Log Bet'}
        </button>
      </div>
    </Modal>
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

function BetRow({ bet, showDate, onEdit, onDelete }: { bet: Bet; showDate: boolean; onEdit: (b: Bet) => void; onDelete: (b: Bet) => void }) {
  const profit = computeProfit(bet);
  return (
    <div className="bets-log__row">
      <div className="bets-log__main">
        {showDate && <span className="bets-log__date">{bet.date}</span>}
        <span className="bets-log__pick">{bet.pick || (bet.legs.length > 0 ? `${bet.legs.length}-leg ${bet.bet_type}` : `${bet.sport} ${bet.bet_type}`)}</span>
        <span className="bets-log__meta">
          {bet.sport} · {bet.sportsbook} · {formatOdds(bet.odds)} · {formatMoney(bet.wager)}
          {bet.stake_type === 'free_bet' && <span className="bets-log__freebet"> · Free bet</span>}
        </span>
        {bet.legs.length > 0 && (
          <span className="bets-log__legs">
            {bet.legs.map((l) => `${l.pick || l.sport}${l.over_under ? ` (${l.over_under})` : ''}`).join(' · ')}
          </span>
        )}
      </div>
      <ResultBadge result={bet.result} />
      <span className={`bets-log__profit ${profit >= 0 ? 'is-up' : 'is-down'}`}>{formatMoney(profit)}</span>
      <KebabMenu
        items={[
          { label: 'Edit', onClick: () => onEdit(bet) },
          { label: 'Delete', onClick: () => onDelete(bet), danger: true, separatorBefore: true },
        ]}
      />
    </div>
  );
}

/** The clicked day: its record, net and amount risked, then every bet made
 * that day with how it did. */
function BetsDayDetail({ date, stat, bets, onClose, onEdit, onDelete }: { date: string; stat: DayStat; bets: Bet[]; onClose: () => void; onEdit: (b: Bet) => void; onDelete: (b: Bet) => void }) {
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
          <BetRow key={bet.id} bet={bet} showDate={false} onEdit={onEdit} onDelete={onDelete} />
        ))}
      </div>
    </div>
  );
}

function LogTab({ bets, onEdit, onDelete }: { bets: Bet[]; onEdit: (b: Bet) => void; onDelete: (b: Bet) => void }) {
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
        <BetsDayDetail date={selectedDate} stat={selectedStat} bets={dayBets} onClose={() => setSelectedDate(null)} onEdit={onEdit} onDelete={onDelete} />
      )}

      <div className="toolbar-row" style={{ marginTop: 16 }}>
        <input className="bets-log__search" placeholder="Search picks, sportsbooks, notes…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">No bets match.</div>
      ) : (
        <div className="bets-log card">
          {filtered.map((bet) => (
            <BetRow key={bet.id} bet={bet} showDate onEdit={onEdit} onDelete={onDelete} />
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
  const [tab, setTab] = useState<BetsTab>('workspace');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Bet | null>(null);
  const [deleting, setDeleting] = useState<Bet | null>(null);

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
          <LogTab bets={bets} onEdit={setEditing} onDelete={setDeleting} />
        ))}
      {tab === 'performance' &&
        (bets.length === 0 ? <div className="empty-state">No bets logged yet.</div> : <PerformanceTab bets={bets} />)}
      {tab === 'trends' && (bets.length === 0 ? <div className="empty-state">No bets logged yet.</div> : <TrendsTab bets={bets} />)}
      {tab === 'banking' && (
        <BetsBankingTab bets={bets} transactions={transactions} onCreate={handleCreateTransaction} onUpdate={handleUpdateTransaction} onDelete={handleDeleteTransaction} />
      )}
      {tab === 'promos' && <BetsPromosTab promos={promos} onCreate={handleCreatePromo} onUpdate={handleUpdatePromo} onDelete={handleDeletePromo} />}

      {adding && <BetFormModal bet={null} betOptions={betOptions} onClose={() => setAdding(false)} onSave={handleCreate} />}
      {editing && <BetFormModal bet={editing} betOptions={betOptions} onClose={() => setEditing(null)} onSave={handleUpdate} />}
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

import { useMemo, useState } from 'react';
import { BET_STAKE_TYPES, type Bet, type BetLeg, type BetLegInput, type BetLegMarket, type BetOption, type BetStakeType } from '../api/types';
import { Modal } from './Modal';
import {
  COMMON_SPORTSBOOKS,
  LEG_MARKETS,
  SPORTS,
  combinedOdds,
  formatMoney,
  formatOdds,
  isMultiLegType,
  legResultsFor,
  legSummary,
  markFromLegResult,
  optionLabel,
  optionValues,
  parlaySport,
  todayLocalISODash,
  yesterdayLocalISODash,
  type LegMark,
} from '../utils/bets';

/* Bet slip (Mike, 2026-10-15 — modeled on Action Network's tracker).
 * Straight / Parlay / Teaser tabs; every pick is a leg card with a market
 * (ML · Spread · Total · Prop), a line with a +/− (or O/U) button and odds
 * typed as plain numbers with a +/− button. A parlay's price comes from its
 * legs unless Mike types the book's price (boosts). New bets save as
 * Pending (result 'tbd'); settling asks only which leg missed. */

type Kind = 'Straight' | 'Parlay' | 'Teaser';
type LineSide = '+' | '-' | 'o' | 'u';
type Sign = '+' | '-';

interface LegDraft {
  key: number;
  sport: string;
  market: BetLegMarket;
  pick: string;
  lineSide: LineSide;
  line: string; // unsigned
  oddsSign: Sign;
  odds: string; // unsigned
  mark: LegMark;
}

let legKey = 0;
const nextKey = () => ++legKey;

const isOU = (m: BetLegMarket) => m === 'Total' || m === 'Prop';

function emptyLeg(sport: string): LegDraft {
  return { key: nextKey(), sport, market: 'Spread', pick: '', lineSide: '+', line: '', oddsSign: '-', odds: '110', mark: null };
}

function draftFromLeg(leg: BetLeg): LegDraft {
  const market: BetLegMarket = leg.market ?? (leg.over_under ? 'Total' : leg.line != null ? 'Spread' : 'ML');
  const lineSide: LineSide = isOU(market) ? (leg.over_under === 'under' ? 'u' : 'o') : leg.line != null && leg.line < 0 ? '-' : '+';
  return {
    key: nextKey(),
    sport: leg.sport,
    market,
    pick: leg.pick ?? '',
    lineSide,
    line: leg.line != null ? String(Math.abs(leg.line)) : '',
    oddsSign: leg.odds != null && leg.odds > 0 ? '+' : '-',
    odds: leg.odds != null ? String(Math.abs(leg.odds)) : '',
    mark: markFromLegResult(leg.result),
  };
}

/** A straight bet logged before the redesign has no leg — build its card
 * from the bet itself (old Line field ATS/ML/o-u → market). */
function draftFromOldStraight(bet: Bet): LegDraft {
  const l = (bet.line ?? '').toLowerCase();
  const market: BetLegMarket = bet.bet_type === 'Prop' ? 'Prop' : l === 'ats' ? 'Spread' : l === 'o/u' ? 'Total' : 'ML';
  return {
    key: nextKey(),
    sport: bet.sport,
    market,
    pick: bet.pick ?? '',
    lineSide: isOU(market) ? 'o' : '+',
    line: '',
    oddsSign: bet.odds > 0 ? '+' : '-',
    odds: String(Math.abs(bet.odds)),
    mark: null,
  };
}

function legInput(d: LegDraft, result: string): BetLegInput {
  const lineNum = d.line.trim() === '' ? null : Number(d.line);
  const oddsNum = d.odds.trim() === '' ? null : Number(d.odds);
  return {
    sport: d.sport,
    market: d.market,
    pick: d.pick.trim() || null,
    line: d.market === 'ML' || lineNum == null || !Number.isFinite(lineNum) ? null : d.lineSide === '-' ? -lineNum : lineNum,
    over_under: isOU(d.market) ? (d.lineSide === 'u' ? 'under' : 'over') : null,
    odds: oddsNum == null || !Number.isFinite(oddsNum) || oddsNum === 0 ? null : d.oddsSign === '-' ? -oddsNum : oddsNum,
    result,
  };
}

function profitFor(risk: number, odds: number | null): number | null {
  if (!risk || odds == null || odds === 0) return null;
  return odds > 0 ? risk * (odds / 100) : risk * (100 / Math.abs(odds));
}

/** Result buttons, Pending first. Labels follow Settings → Bets → Result
 * but read as verbs (Won / Lost) for the default four. */
const RESULT_VERBS: Record<string, string> = { tbd: 'Pending', win: 'Won', loss: 'Lost', push: 'Push', void: 'Void', cashed_out: 'Cashed Out' };
function resultChoices(betOptions: BetOption[], current: string): { value: string; label: string }[] {
  const values = optionValues(betOptions, 'result');
  const list = values.length > 0 ? values : ['tbd', 'win', 'loss', 'push', 'void', 'cashed_out'];
  const withCurrent = list.includes(current) ? list : [...list, current];
  const ordered = [...withCurrent].sort((a, b) => (a === 'tbd' ? -1 : b === 'tbd' ? 1 : 0));
  return ordered.map((v) => ({ value: v, label: RESULT_VERBS[v] ?? optionLabel(betOptions, 'result', v) }));
}

function nextMark(mark: LegMark, betResult: string): LegMark {
  const cycle: LegMark[] = betResult === 'win' ? [null, 'push', 'void'] : [null, 'loss', 'push', 'void'];
  return cycle[(cycle.indexOf(mark) + 1) % cycle.length];
}

const MARK_TEXT: Record<string, string> = { win: 'Hit', loss: 'Missed', push: 'Push', void: 'Void', pending: 'Not graded' };

/** Won / Lost / … buttons plus, for a multi-leg bet, the leg list Mike taps
 * to say which leg missed (tap again for push / void). Shared by the slip
 * and the Log's Settle sheet. */
function ResultSection({
  choices,
  result,
  setResult,
  legs,
  marks,
  setMark,
  multi,
  cashout,
  setCashout,
}: {
  choices: { value: string; label: string }[];
  result: string;
  setResult: (r: string) => void;
  legs: string[];
  marks: LegMark[];
  setMark: (i: number, m: LegMark) => void;
  multi: boolean;
  cashout: string;
  setCashout: (v: string) => void;
}) {
  const legResults = legResultsFor(result, marks);
  const showLegs = multi && legs.length > 0 && (result === 'win' || result === 'loss');
  return (
    <div className="bet-slip__section">
      <span className="bet-slip__label">Result</span>
      <div className="bet-slip__pills">
        {choices.map((c) => (
          <button
            key={c.value}
            type="button"
            className={`bet-slip__pill${result === c.value ? ' is-on' : ''}${result === c.value && c.value === 'loss' ? ' is-loss' : ''}`}
            onClick={() => setResult(c.value)}
          >
            {c.label}
          </button>
        ))}
      </div>
      {result === 'cashed_out' && (
        <label className="bet-slip__inline-field">
          <span>Cashed out for</span>
          <span className="bet-slip__money">
            $<input inputMode="decimal" placeholder="0.00" value={cashout} onChange={(e) => setCashout(e.target.value.replace(/[^0-9.]/g, ''))} aria-label="Cash-out amount" />
          </span>
        </label>
      )}
      {showLegs && (
        <div className="bet-slip__grade">
          <div className="bet-slip__grade-title">
            {result === 'loss' ? 'Which leg missed?' : 'Any pushes?'} <span>{result === 'loss' ? 'Tap it — the rest count as hits.' : 'Tap a leg to mark it a push or void.'}</span>
          </div>
          {legs.map((label, i) => {
            const r = legResults[i];
            return (
              <button key={i} type="button" className={`bet-slip__grade-leg is-${r}`} onClick={() => setMark(i, nextMark(marks[i], result))}>
                <span className="bet-slip__grade-dot" aria-hidden="true">
                  {r === 'win' ? '✓' : r === 'loss' ? '✕' : r === 'pending' ? '' : '–'}
                </span>
                <span className="bet-slip__grade-text">
                  <span>{label}</span>
                  <span className="bet-slip__grade-sub">{MARK_TEXT[r] ?? r}</span>
                </span>
              </button>
            );
          })}
          {result === 'loss' && !marks.some((m) => m === 'loss') && <div className="bet-slip__hint">Skip it and only the bet is settled — the legs stay ungraded.</div>}
        </div>
      )}
    </div>
  );
}

function cashoutProfit(result: string, cashout: string, wager: number, stake: BetStakeType): number | null {
  if (result !== 'cashed_out') return null;
  const amt = Number(cashout);
  if (cashout.trim() === '' || !Number.isFinite(amt)) return null;
  return Math.round((stake === 'free_bet' ? amt : amt - wager) * 100) / 100;
}

function SignedInput({
  sides,
  side,
  setSide,
  value,
  setValue,
  placeholder,
  label,
  decimal,
}: {
  sides: { v: string; label: string; aria: string }[];
  side: string;
  setSide: (v: string) => void;
  value: string;
  setValue: (v: string) => void;
  placeholder: string;
  label: string;
  decimal?: boolean;
}) {
  return (
    <div className="bet-slip__signed">
      {sides.map((s) => (
        <button key={s.v} type="button" className={`bet-slip__sign${side === s.v ? ' is-on' : ''}`} aria-label={s.aria} aria-pressed={side === s.v} onClick={() => setSide(s.v)}>
          {s.label}
        </button>
      ))}
      <input
        inputMode={decimal ? 'decimal' : 'numeric'}
        placeholder={placeholder}
        value={value}
        aria-label={label}
        onChange={(e) => {
          const raw = e.target.value;
          // Typing a sign flips the button instead of landing in the box.
          if (raw.includes('-') && sides.some((s) => s.v === '-')) setSide('-');
          else if (raw.includes('+') && sides.some((s) => s.v === '+')) setSide('+');
          setValue(raw.replace(decimal ? /[^0-9.]/g : /[^0-9]/g, ''));
        }}
      />
    </div>
  );
}

const PLUS_MINUS = [
  { v: '+', label: '+', aria: 'Plus' },
  { v: '-', label: '−', aria: 'Minus' },
];
const OVER_UNDER = [
  { v: 'o', label: 'O', aria: 'Over' },
  { v: 'u', label: 'U', aria: 'Under' },
];

function LegCard({
  leg,
  index,
  canRemove,
  update,
  remove,
}: {
  leg: LegDraft;
  index: number;
  canRemove: boolean;
  update: (patch: Partial<LegDraft>) => void;
  remove: () => void;
}) {
  const sports = SPORTS.includes(leg.sport) ? SPORTS : [...SPORTS, leg.sport];
  const placeholder = leg.market === 'Prop' ? 'Player & stat (Mahomes pass yds)' : leg.market === 'Total' ? 'Game (KC @ BUF)' : 'Team (Chiefs)';
  const preview = legSummary(legInput(leg, 'pending'));
  return (
    <div className="bet-slip__leg">
      <div className="bet-slip__leg-head">
        <select className="bet-slip__sport" value={leg.sport} onChange={(e) => update({ sport: e.target.value })} aria-label={`Leg ${index + 1} sport`}>
          {sports.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input className="bet-slip__pick" placeholder={placeholder} value={leg.pick} onChange={(e) => update({ pick: e.target.value })} aria-label={`Leg ${index + 1} pick`} />
        {canRemove && (
          <button type="button" className="bet-slip__remove" onClick={remove} aria-label={`Remove leg ${index + 1}`}>
            ✕
          </button>
        )}
      </div>
      <div className="bet-slip__seg bet-slip__seg--4" role="group" aria-label="Market">
        {LEG_MARKETS.map((m) => (
          <button
            key={m}
            type="button"
            className={leg.market === m ? 'is-on' : ''}
            aria-pressed={leg.market === m}
            onClick={() => update({ market: m, lineSide: isOU(m) ? (isOU(leg.market) ? leg.lineSide : 'o') : isOU(leg.market) ? '+' : leg.lineSide })}
          >
            {m}
          </button>
        ))}
      </div>
      <div className="bet-slip__leg-nums">
        {leg.market !== 'ML' && (
          <label className="bet-slip__num">
            <span className="bet-slip__label">{leg.market === 'Spread' ? 'Spread' : leg.market === 'Total' ? 'Total' : 'Line'}</span>
            <SignedInput
              sides={isOU(leg.market) ? OVER_UNDER : PLUS_MINUS}
              side={leg.lineSide}
              setSide={(v) => update({ lineSide: v as LineSide })}
              value={leg.line}
              setValue={(v) => update({ line: v })}
              placeholder={leg.market === 'Spread' ? '2.5' : leg.market === 'Total' ? '47.5' : '275.5'}
              label={`Leg ${index + 1} line`}
              decimal
            />
          </label>
        )}
        <label className="bet-slip__num">
          <span className="bet-slip__label">Odds</span>
          <SignedInput
            sides={PLUS_MINUS}
            side={leg.oddsSign}
            setSide={(v) => update({ oddsSign: v as Sign })}
            value={leg.odds}
            setValue={(v) => update({ odds: v })}
            placeholder="110"
            label={`Leg ${index + 1} odds`}
          />
        </label>
      </div>
      <div className="bet-slip__leg-preview">{preview}</div>
    </div>
  );
}

export function BetSlipModal({
  bet,
  betOptions,
  recentBooks,
  onClose,
  onSave,
}: {
  bet: Bet | null;
  betOptions: BetOption[];
  recentBooks: string[];
  onClose: () => void;
  onSave: (params: Record<string, unknown>) => Promise<void>;
}) {
  const betTypeOptions = optionValues(betOptions, 'bet_type');
  const tipperOptions = optionValues(betOptions, 'tipper');

  const initial = useMemo(() => {
    const t = bet?.bet_type ?? 'Parlay';
    const kind: Kind = t === 'Teaser' ? 'Teaser' : isMultiLegType(t) ? 'Parlay' : bet ? 'Straight' : 'Parlay';
    const legs = bet
      ? bet.legs.length > 0
        ? bet.legs.map(draftFromLeg)
        : [draftFromOldStraight(bet)]
      : [emptyLeg('NFL'), emptyLeg('NFL')];
    const fromLegs = combinedOdds(legs.map((l) => legInput(l, 'pending')));
    const override = bet && kind !== 'Straight' && (kind === 'Teaser' || fromLegs == null || fromLegs !== bet.odds) ? { sign: (bet.odds > 0 ? '+' : '-') as Sign, value: String(Math.abs(bet.odds)) } : null;
    const known = ['Straight', 'Parlay', 'SGP', 'SGPx', 'Teaser', 'Future', 'Prop'];
    return {
      kind,
      parlayKind: t === 'SGP' || t === 'SGPx' ? t : 'Parlay',
      future: t === 'Future',
      customType: bet && !known.includes(t) ? t : null,
      legs,
      override,
    };
  }, [bet]);

  const [kind, setKind] = useState<Kind>(initial.kind);
  const [parlayKind, setParlayKind] = useState(initial.parlayKind);
  const [future, setFuture] = useState(initial.future);
  const [legs, setLegs] = useState<LegDraft[]>(initial.legs);
  const [override, setOverride] = useState<{ sign: Sign; value: string } | null>(initial.override);
  const [risk, setRisk] = useState(bet ? String(bet.wager) : '');
  const books = useMemo(() => {
    const list = [...new Set([...recentBooks, ...COMMON_SPORTSBOOKS])].slice(0, 6);
    return list;
  }, [recentBooks]);
  const [book, setBook] = useState(bet?.sportsbook ?? books[0] ?? '');
  const [otherBook, setOtherBook] = useState(!!bet && !books.includes(bet.sportsbook));
  const today = todayLocalISODash();
  const yesterday = yesterdayLocalISODash();
  // New bets default to yesterday — Mike usually logs the day after.
  const [date, setDate] = useState(bet?.date ?? yesterday);
  const [pickDate, setPickDate] = useState(!!bet && bet.date !== today && bet.date !== yesterday);
  const [stake, setStake] = useState<BetStakeType>(bet?.stake_type ?? 'cash');
  const [result, setResult] = useState<string>(bet?.result ?? 'tbd');
  const [cashout, setCashout] = useState(bet?.result === 'cashed_out' && bet.manual_profit != null ? String(Math.round((bet.manual_profit + (bet.stake_type === 'free_bet' ? 0 : bet.wager)) * 100) / 100) : '');
  const [tipper, setTipper] = useState(bet?.tipper ?? '');
  const [notes, setNotes] = useState(bet?.notes ?? '');
  const [manualProfit, setManualProfit] = useState(bet?.manual_profit != null && bet.result !== 'cashed_out' ? String(bet.manual_profit) : '');
  const [showMore, setShowMore] = useState(!!(bet?.tipper || bet?.notes || (bet?.manual_profit != null && bet.result !== 'cashed_out')));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const multi = kind !== 'Straight';
  const shownLegs = multi ? legs : legs.slice(0, 1);
  const legInputs = shownLegs.map((l) => legInput(l, 'pending'));
  const fromLegs = kind === 'Parlay' ? combinedOdds(legInputs) : null;
  const overrideOdds = override && override.value.trim() !== '' ? Number(override.value) * (override.sign === '-' ? -1 : 1) : null;
  const odds = kind === 'Straight' ? legInputs[0]?.odds ?? null : overrideOdds ?? fromLegs;
  const riskNum = Number(risk) || 0;
  const toWin = profitFor(riskNum, odds);
  const n = shownLegs.length;
  const headline = kind === 'Straight' ? (future ? 'Future' : 'Straight Bet') : kind === 'Teaser' ? `${n}-Team Teaser` : `${n}-Leg ${parlayKind === 'SGP' ? 'Same Game Parlay' : parlayKind === 'SGPx' ? 'SGP+' : 'Parlay'}`;
  const choices = resultChoices(betOptions, result);

  function updateLeg(i: number, patch: Partial<LegDraft>) {
    setLegs((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  function pickKind(k: Kind) {
    setKind(k);
    if (k !== 'Straight' && legs.length < 2) setLegs((prev) => [...prev, emptyLeg(prev[prev.length - 1]?.sport ?? 'NFL')]);
    if (k === 'Teaser') setLegs((prev) => prev.map((l) => (l.market === 'ML' ? { ...l, market: 'Spread' } : l)));
  }

  function betTypeValue(): string {
    const has = (t: string) => betTypeOptions.length === 0 || betTypeOptions.includes(t);
    if (kind === 'Parlay') return has(parlayKind) ? parlayKind : 'Parlay';
    if (kind === 'Teaser') return 'Teaser';
    if (initial.customType) return initial.customType;
    if (future && has('Future')) return 'Future';
    if (shownLegs[0]?.market === 'Prop' && has('Prop')) return 'Prop';
    return 'Straight';
  }

  async function handleSave() {
    const sportsbook = book.trim();
    if (!sportsbook) return setError('Pick a sportsbook.');
    if (!(riskNum > 0)) return setError('Enter how much you risked.');
    if (multi && n < 2) return setError(`A ${kind.toLowerCase()} needs at least two legs.`);
    if (odds == null || !Number.isFinite(odds) || odds === 0) {
      return setError(kind === 'Straight' ? 'Enter the odds.' : kind === 'Teaser' ? "Enter the teaser's price (e.g. −120)." : "Add odds to every leg, or tap Odds to type the book's price.");
    }
    const marks = shownLegs.map((l) => l.mark);
    const legResults = multi ? legResultsFor(result, marks) : [['win', 'loss', 'push', 'void'].includes(result) ? result : 'pending'];
    const legsPayload = shownLegs.map((l, i) => legInput(l, legResults[i]));
    const cash = cashoutProfit(result, cashout, riskNum, stake);
    if (result === 'cashed_out' && cash == null) return setError('Enter what you cashed out for.');
    const manual = result === 'cashed_out' ? cash : manualProfit.trim() !== '' && Number.isFinite(Number(manualProfit)) ? Number(manualProfit) : null;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        date,
        sport: parlaySport(legsPayload.map((l) => l.sport)) ?? legsPayload[0]?.sport ?? 'Other',
        sportsbook,
        bet_type: betTypeValue(),
        tipper: tipper.trim(),
        odds,
        wager: riskNum,
        result,
        stake_type: stake,
        manual_profit: manual,
        notes: notes.trim(),
        legs: legsPayload,
      });
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  return (
    <Modal title={bet ? 'Edit Bet' : 'New Bet'} onClose={onClose} className="bet-slip-modal">
      <div className="bet-slip">
        <div className="bet-slip__tabs" role="tablist">
          {(['Straight', 'Parlay', 'Teaser'] as Kind[]).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? 'is-on' : ''} onClick={() => pickKind(k)}>
              {k}
            </button>
          ))}
        </div>

        {kind === 'Parlay' && (
          <div className="bet-slip__pills">
            {[
              ['Parlay', 'Parlay'],
              ['SGP', 'Same Game'],
              ['SGPx', 'SGP+'],
            ].map(([v, label]) => (
              <button key={v} type="button" className={`bet-slip__pill${parlayKind === v ? ' is-on' : ''}`} onClick={() => setParlayKind(v)}>
                {label}
              </button>
            ))}
          </div>
        )}
        {kind === 'Straight' && !initial.customType && (
          <div className="bet-slip__pills">
            <button type="button" className={`bet-slip__pill${!future ? ' is-on' : ''}`} onClick={() => setFuture(false)}>
              Game
            </button>
            <button type="button" className={`bet-slip__pill${future ? ' is-on' : ''}`} onClick={() => setFuture(true)}>
              Future
            </button>
          </div>
        )}

        <div className="bet-slip__summary">
          <div className="bet-slip__summary-head">
            <span>{headline}</span>
            <span className="bet-slip__summary-odds">{odds != null && odds !== 0 ? formatOdds(odds) : '—'}</span>
          </div>
          <div className="bet-slip__tiles">
            <label className="bet-slip__tile">
              <span className="bet-slip__label">Risk</span>
              <span className="bet-slip__money">
                $<input inputMode="decimal" placeholder="10" value={risk} onChange={(e) => setRisk(e.target.value.replace(/[^0-9.]/g, ''))} aria-label="Risk" />
              </span>
            </label>
            <div className="bet-slip__tile">
              <span className="bet-slip__label">To Win</span>
              <span className="bet-slip__tile-value">{toWin != null ? formatMoney(toWin).replace(/^\+/, '') : '—'}</span>
            </div>
            {kind === 'Straight' ? (
              <div className="bet-slip__tile">
                <span className="bet-slip__label">Odds</span>
                <span className="bet-slip__tile-value">{odds != null && odds !== 0 ? formatOdds(odds) : '—'}</span>
              </div>
            ) : override || kind === 'Teaser' ? (
              <div className="bet-slip__tile">
                <span className="bet-slip__label">Odds</span>
                <SignedInput
                  sides={PLUS_MINUS}
                  side={override?.sign ?? '-'}
                  setSide={(v) => setOverride({ sign: v as Sign, value: override?.value ?? '' })}
                  value={override?.value ?? ''}
                  setValue={(v) => setOverride({ sign: override?.sign ?? '-', value: v })}
                  placeholder={kind === 'Teaser' ? '120' : '265'}
                  label="Bet odds"
                />
              </div>
            ) : (
              <button
                type="button"
                className="bet-slip__tile bet-slip__tile--btn"
                onClick={() => setOverride({ sign: fromLegs != null && fromLegs > 0 ? '+' : '-', value: fromLegs != null ? String(Math.abs(fromLegs)) : '' })}
                aria-label="Type the book's odds instead"
              >
                <span className="bet-slip__label">Odds</span>
                <span className="bet-slip__tile-value">{fromLegs != null ? formatOdds(fromLegs) : '—'}</span>
              </button>
            )}
          </div>
          {kind === 'Parlay' && !override && <div className="bet-slip__hint">Odds worked out from the legs. Tap Odds to type the book's price (boosts).</div>}
          {kind === 'Parlay' && override && (
            <button type="button" className="link-btn bet-slip__hint-btn" onClick={() => setOverride(null)}>
              Use the legs' odds{fromLegs != null ? ` (${formatOdds(fromLegs)})` : ''}
            </button>
          )}
        </div>

        <div className="bet-slip__legs">
          {shownLegs.map((leg, i) => (
            <LegCard key={leg.key} leg={leg} index={i} canRemove={multi && legs.length > 2} update={(p) => updateLeg(i, p)} remove={() => setLegs((prev) => prev.filter((_, j) => j !== i))} />
          ))}
          {multi && (
            <button type="button" className="bet-slip__add" onClick={() => setLegs((prev) => [...prev, emptyLeg(prev[prev.length - 1]?.sport ?? 'NFL')])}>
              + Add Leg
            </button>
          )}
        </div>

        <div className="bet-slip__section">
          <span className="bet-slip__label">Sportsbook</span>
          <div className="bet-slip__pills">
            {books.map((b) => (
              <button
                key={b}
                type="button"
                className={`bet-slip__pill${!otherBook && book === b ? ' is-on' : ''}`}
                onClick={() => {
                  setBook(b);
                  setOtherBook(false);
                }}
              >
                {b}
              </button>
            ))}
            <button
              type="button"
              className={`bet-slip__pill${otherBook ? ' is-on' : ''}`}
              onClick={() => {
                setOtherBook(true);
                if (books.includes(book)) setBook('');
              }}
            >
              Other
            </button>
          </div>
          {otherBook && <input className="bet-slip__text" placeholder="Sportsbook name" value={book} onChange={(e) => setBook(e.target.value)} aria-label="Sportsbook name" autoFocus />}
        </div>

        <div className="bet-slip__duo">
          <div className="bet-slip__section">
            <span className="bet-slip__label">Date</span>
            <div className="bet-slip__seg">
              <button
                type="button"
                className={!pickDate && date === today ? 'is-on' : ''}
                onClick={() => {
                  setPickDate(false);
                  setDate(today);
                }}
              >
                Today
              </button>
              <button
                type="button"
                className={!pickDate && date === yesterday ? 'is-on' : ''}
                onClick={() => {
                  setPickDate(false);
                  setDate(yesterday);
                }}
              >
                Yesterday
              </button>
              <button type="button" className={pickDate ? 'is-on' : ''} onClick={() => setPickDate(true)}>
                Pick
              </button>
            </div>
            {pickDate && <input className="bet-slip__text" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />}
          </div>
          <div className="bet-slip__section">
            <span className="bet-slip__label">Paid With</span>
            <div className="bet-slip__seg">
              {BET_STAKE_TYPES.map((t) => (
                <button key={t.value} type="button" className={stake === t.value ? 'is-on' : ''} onClick={() => setStake(t.value)}>
                  {t.value === 'free_bet' ? 'Free Bet' : 'Cash'}
                </button>
              ))}
            </div>
          </div>
        </div>

        <ResultSection
          choices={choices}
          result={result}
          setResult={setResult}
          legs={shownLegs.map((l) => legSummary(legInput(l, 'pending')))}
          marks={shownLegs.map((l) => l.mark)}
          setMark={(i, m) => updateLeg(legs.indexOf(shownLegs[i]), { mark: m })}
          multi={multi}
          cashout={cashout}
          setCashout={setCashout}
        />

        <button type="button" className="link-btn bet-slip__more" onClick={() => setShowMore((v) => !v)}>
          {showMore ? '− Fewer details' : '+ Tipper, notes, profit override'}
        </button>
        {showMore && (
          <div className="bet-slip__more-fields">
            <label className="bet-slip__field">
              <span className="bet-slip__label">Tipper</span>
              <input className="bet-slip__text" list="bet-slip-tippers" placeholder="Who's the pick from?" value={tipper} onChange={(e) => setTipper(e.target.value)} />
              <datalist id="bet-slip-tippers">
                {tipperOptions.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </label>
            <label className="bet-slip__field">
              <span className="bet-slip__label">Notes</span>
              <textarea className="bet-slip__text" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
            {result !== 'cashed_out' && (
              <label className="bet-slip__field">
                <span className="bet-slip__label">Actual profit / loss (overrides the math — boosts, partial voids)</span>
                <input className="bet-slip__text" inputMode="decimal" placeholder="e.g. 37.50 or -25" value={manualProfit} onChange={(e) => setManualProfit(e.target.value)} />
              </label>
            )}
          </div>
        )}

        {error && <div className="bets-form__error">{error}</div>}

        <div className="bet-slip__save">
          <button type="button" className="bet-slip__save-btn" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : `${bet ? 'Save' : 'Save Bet'}${riskNum > 0 && toWin != null ? ` · $${riskNum} to win ${formatMoney(toWin).replace(/^\+/, '')}` : ''}`}
          </button>
          {result === 'tbd' && <div className="bet-slip__hint bet-slip__hint--center">Saved as Pending — settle it from the Log when the games end.</div>}
        </div>
      </div>
    </Modal>
  );
}

/** The Log's Settle sheet for a pending bet: Won / Lost / … and, for a
 * multi-leg bet, which leg missed. Sends the full leg list back with new
 * results (PATCH replaces legs). */
export function SettleBetModal({ bet, betOptions, onClose, onSave }: { bet: Bet; betOptions: BetOption[]; onClose: () => void; onSave: (params: Record<string, unknown>) => Promise<void> }) {
  const multi = isMultiLegType(bet.bet_type) && bet.legs.length > 0;
  const [result, setResult] = useState<string>(bet.result === 'tbd' ? 'win' : bet.result);
  const [marks, setMarks] = useState<LegMark[]>(bet.legs.map((l) => markFromLegResult(l.result)));
  const [cashout, setCashout] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = resultChoices(betOptions, result);
  const legResults = multi ? legResultsFor(result, marks) : bet.legs.map(() => (['win', 'loss', 'push', 'void'].includes(result) ? result : 'pending'));
  const profit = result === 'cashed_out' ? cashoutProfit(result, cashout, bet.wager, bet.stake_type) : null;
  const preview =
    result === 'win' ? profitFor(bet.wager, bet.odds) : result === 'loss' ? (bet.stake_type === 'free_bet' ? 0 : -bet.wager) : result === 'cashed_out' ? profit : result === 'tbd' ? null : 0;

  async function save() {
    if (result === 'cashed_out' && profit == null) return setError('Enter what you cashed out for.');
    setSaving(true);
    setError(null);
    try {
      const params: Record<string, unknown> = { result };
      if (result === 'cashed_out') params.manual_profit = profit;
      else if (bet.result === 'cashed_out') params.manual_profit = null;
      if (bet.legs.length > 0) {
        params.legs = bet.legs.map((l, i) => ({
          sport: l.sport,
          market: l.market ?? (l.over_under ? 'Total' : l.line != null ? 'Spread' : 'ML'),
          pick: l.pick,
          line: l.line,
          over_under: l.over_under,
          odds: l.odds,
          result: legResults[i],
        }));
      }
      await onSave(params);
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  return (
    <Modal title="Settle Bet" onClose={onClose} className="bet-slip-modal">
      <div className="bet-slip">
        <div className="bet-slip__summary">
          <div className="bet-slip__summary-head">
            <span>{multi ? `${bet.legs.length}-Leg ${bet.bet_type}` : bet.legs[0] ? legSummary(bet.legs[0]) : `${bet.sport} ${bet.bet_type}`}</span>
            <span className="bet-slip__summary-odds">{formatOdds(bet.odds)}</span>
          </div>
          <div className="bet-slip__hint">
            {bet.sportsbook} · {bet.sport} · ${bet.wager}
            {bet.stake_type === 'free_bet' ? ' free bet' : ''}
          </div>
        </div>
        <ResultSection
          choices={choices}
          result={result}
          setResult={setResult}
          legs={bet.legs.map((l) => legSummary(l))}
          marks={marks}
          setMark={(i, m) => setMarks((prev) => prev.map((x, j) => (j === i ? m : x)))}
          multi={multi}
          cashout={cashout}
          setCashout={setCashout}
        />
        {error && <div className="bets-form__error">{error}</div>}
        <div className="bet-slip__save">
          <button type="button" className="bet-slip__save-btn" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : `Settle${preview != null ? ` · ${formatMoney(preview)}` : ''}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

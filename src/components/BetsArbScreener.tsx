import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { BetPromo, BetSlateGame } from '../api/types';
import { formatMoney, sportsbookBrand } from '../utils/bets';
import {
  americanToDecimal,
  bestSpot,
  findPromoPlays,
  formatAmerican,
  HEDGE_BOOK,
  minBoostToArb,
  promoFit,
  solveArb,
  unusablePromos,
  type ArbPlay,
  type BoardArb,
  type GameSpot,
} from '../utils/promoArb';

/** Workspace → Arb Screener (2026-10-23). See src/utils/promoArb.ts for the
 * rules; this is just the board. Lines are DraftKings via ESPN, so it can't
 * scan other books' prices — promo plays assume the promo book's price is
 * close to DK's, and every play has a calculator for the real numbers. */

const pct = (n: number, digits = 1) => `${(n * 100).toFixed(digits)}%`;
const SPOTS_SHOWN = 6;

function kickoff(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function BookBadge({ book }: { book: string }) {
  // The hedge on a DraftKings promo can go anywhere but DK — no brand to show.
  if (book === HEDGE_BOOK)
    return (
      <span className="bets-promos__badge bets-arb__badge bets-arb__badge--any" title="Any book other than the promo's — DK's price shown">
        ANY
      </span>
    );
  const brand = sportsbookBrand(book);
  return (
    <span className="bets-promos__badge bets-arb__badge" style={{ background: brand.color }} title={book}>
      {brand.mono}
    </span>
  );
}

function useSlateLines(date: string, sports: string[]) {
  const [games, setGames] = useState<BetSlateGame[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const key = sports.join(',');
  useEffect(() => {
    if (!key) {
      setGames([]);
      return;
    }
    let cancelled = false;
    setGames(null);
    setNote(null);
    api
      .getBetSlateLines(date, key.split(','))
      .then((r) => {
        if (cancelled) return;
        setGames(r.games);
        setNote(r.note);
      })
      .catch(() => {
        if (cancelled) return;
        setGames([]);
        setNote("Couldn't load the day's lines right now.");
      });
    return () => {
      cancelled = true;
    };
  }, [date, key]);
  return { games, note };
}

/** Re-runs a play with the real odds Mike sees in each app. */
function PlayCalculator({ play }: { play: ArbPlay }) {
  const [prices, setPrices] = useState(() => play.legs.map((l) => formatAmerican(l.price)));
  const [boosts, setBoosts] = useState(() => play.legs.map((l) => (l.boost ? String(Math.round(l.boost * 1000) / 10) : '')));
  const parsed = prices.map((p) => {
    const t = p.trim().replace(/^ev(en)?$/i, '+100');
    const n = Number(t);
    return Number.isFinite(n) && Math.abs(n) >= 100 ? n : null;
  });
  const boostNums = boosts.map((b) => (b.trim() ? Number(b) / 100 : 0));
  const valid = parsed.every((p) => p != null) && boostNums.every((b) => Number.isFinite(b) && b >= 0);
  const result = valid
    ? solveArb(
        play.legs.map((l, i) => ({ price: parsed[i]!, boost: boostNums[i], freeBet: l.freeBet, cap: l.cap })) as [
          Parameters<typeof solveArb>[0][0],
          Parameters<typeof solveArb>[0][1],
        ]
      )
    : null;
  // When a promo leg sits beside a plain leg, say what boost the real prices need.
  const promoIdx = play.legs.findIndex((l) => l.boost > 0);
  const needs =
    valid && result && !result.isArb && play.kind === 'solo' && promoIdx >= 0
      ? minBoostToArb(parsed[promoIdx]!, parsed[1 - promoIdx]!)
      : null;

  return (
    <div className="bets-arb__calc">
      <div className="bets-arb__calc-grid">
        {play.legs.map((leg, i) => (
          <div key={i} className="bets-arb__calc-leg">
            <div className="bets-arb__calc-label">
              <BookBadge book={leg.book} /> {leg.label}
              {leg.freeBet && <span className="bets-arb__tag">Free bet</span>}
            </div>
            <label className="bets-arb__calc-field">
              <span>Odds</span>
              <input
                inputMode="text"
                value={prices[i]}
                onChange={(e) => setPrices((p) => p.map((v, j) => (j === i ? e.target.value : v)))}
                aria-label={`${leg.book} odds`}
              />
            </label>
            {leg.promo && !leg.freeBet && (
              <label className="bets-arb__calc-field">
                <span>Boost %</span>
                <input
                  inputMode="decimal"
                  value={boosts[i]}
                  onChange={(e) => setBoosts((b) => b.map((v, j) => (j === i ? e.target.value : v)))}
                  aria-label={`${leg.book} boost percent`}
                />
              </label>
            )}
            {result && (
              <div className="bets-arb__calc-out">
                Stake <strong>{formatMoney(result.legs[i].stake)}</strong>
                {boostNums[i] > 0 && <> at {formatAmerican(result.legs[i].effectivePrice)}</>} · pays {formatMoney(result.legs[i].payout)}
              </div>
            )}
          </div>
        ))}
      </div>
      {!valid && <div className="bets-arb__calc-result text-muted">Enter American odds like −110 or +150.</div>}
      {result && result.isArb && (
        <div className="bets-arb__calc-result is-arb">
          Locked {formatMoney(result.profit)} either way · {pct(result.roi)} on {formatMoney(result.cashStaked)} cash
        </div>
      )}
      {result && !result.isArb && (
        <div className="bets-arb__calc-result is-miss">
          Not an arb at these prices ({formatMoney(result.profit)})
          {needs != null && needs > 0 && <> — the boost would need to be {pct(needs)}+</>}.
        </div>
      )}
    </div>
  );
}

const KIND_LABEL: Record<ArbPlay['kind'], string> = { pair: 'Two promos', solo: 'Boost', freebet: 'Free bet' };

function PlayRow({ play }: { play: ArbPlay }) {
  const [open, setOpen] = useState(false);
  const { result } = play;
  return (
    <div className={`bets-arb__play${open ? ' is-open' : ''}`}>
      <div className="bets-arb__play-main">
        <div className="bets-arb__play-head">
          <span className={`bets-arb__kind bets-arb__kind--${play.kind}`}>{KIND_LABEL[play.kind]}</span>
          <span className="bets-arb__game">
            {play.game.sport} · {play.game.matchup}
          </span>
          <span className="bets-arb__time text-muted">{kickoff(play.game.startTime)}</span>
        </div>
        <div className="bets-arb__legs">
          {play.legs.map((leg, i) => (
            <div key={i} className="bets-arb__leg">
              <BookBadge book={leg.book} />
              <span className="bets-arb__leg-label">{leg.label}</span>
              <span className="bets-arb__leg-price">
                {formatAmerican(leg.price)}
                {leg.boost > 0 && (
                  <>
                    {' '}
                    → <strong>{formatAmerican(result.legs[i].effectivePrice)}</strong> <span className="text-muted">({pct(leg.boost, 0)} boost)</span>
                  </>
                )}
                {leg.freeBet && <span className="bets-arb__tag">Free bet</span>}
              </span>
              <span className="bets-arb__leg-stake">{formatMoney(result.legs[i].stake)}</span>
            </div>
          ))}
        </div>
        <div className="bets-arb__play-foot">
          <span className="bets-arb__profit">+{formatMoney(result.profit)} locked</span>
          <span className="text-muted">
            {play.kind === 'freebet'
              ? `${pct(result.profit / result.legs[0].stake, 0)} of the free bet`
              : `${pct(result.roi)} on ${formatMoney(result.cashStaked)}`}
            {!play.sized && ' · per $100 (no max bet set)'}
            {play.otherGames > 0 && ` · works on ${play.otherGames} other game${play.otherGames === 1 ? '' : 's'}`}
          </span>
          <button type="button" className="chip bets-arb__toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? 'Hide' : 'Check real odds'}
          </button>
        </div>
        {play.warnings.map((w) => (
          <div key={w} className="bets-arb__warning">
            ⚠ {w}
          </div>
        ))}
      </div>
      {open && <PlayCalculator play={play} />}
    </div>
  );
}

function SpotRow({ spot, clearedBy }: { spot: GameSpot; clearedBy: BetPromo[] }) {
  return (
    <tr>
      <td className="bets-arb__spot-game">
        <span className="text-muted">{spot.game.sport}</span> {spot.game.matchup}
        <div className="bets-arb__spot-time text-muted">{kickoff(spot.game.startTime)}</div>
      </td>
      <td>
        Boost <strong>{spot.boosted.label}</strong> {formatAmerican(spot.boosted.price)}
        <div className="text-muted">
          vs {spot.other.label} {formatAmerican(spot.other.price)}
        </div>
      </td>
      <td className="bets-arb__spot-min">
        {spot.minBoost <= 0 ? <span className="bets-arb__profit">Arb now</span> : pct(spot.minBoost)}
        {clearedBy.length > 0 && (
          <div className="bets-arb__cleared" title={clearedBy.map((p) => `${p.sportsbook}: ${p.description}`).join('\n')}>
            {clearedBy.map((p) => (
              <BookBadge key={p.id} book={p.sportsbook} />
            ))}{' '}
            clears it
          </div>
        )}
      </td>
    </tr>
  );
}

export function BetsArbScreener({
  date,
  sports,
  promos,
  boardArbs,
  collapsed,
  onToggleCollapse,
}: {
  date: string;
  sports: string[];
  promos: BetPromo[]; // active today
  boardArbs: { matchup: string; sport: string; arb: BoardArb }[];
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const { games, note } = useSlateLines(date, sports);
  const [showAllSpots, setShowAllSpots] = useState(false);

  const plays = useMemo(() => (games ? findPromoPlays(games, promos) : []), [games, promos]);
  const skipped = useMemo(() => unusablePromos(promos), [promos]);
  const spots = useMemo(
    () =>
      (games ?? [])
        .filter((g) => g.state === 'pre')
        .map(bestSpot)
        .filter((s): s is GameSpot => s !== null)
        .sort((a, b) => a.minBoost - b.minBoost),
    [games]
  );
  // Boost promos that clear a spot on their own (sport + min odds allowing).
  const boostFits = useMemo(() => promos.map(promoFit).filter((f) => f.use?.kind === 'boost'), [promos]);
  const clearing = (spot: GameSpot) =>
    boostFits
      .filter((f) => (!f.promo.sport || f.promo.sport === spot.game.sport) && f.use!.kind === 'boost' && f.use!.boost >= spot.minBoost)
      .filter((f) => f.minOdds == null || americanToDecimal(spot.boosted.price) >= americanToDecimal(f.minOdds))
      .map((f) => f.promo);

  const count = plays.length + boardArbs.length;
  const shownSpots = showAllSpots ? spots : spots.slice(0, SPOTS_SHOWN);
  const priced = (games ?? []).filter((g) => g.odds).length;

  return (
    <div className="bets-workspace__section card bets-arb">
      <div className="bets-promos__header">
        <button type="button" className="bets-workspace__section-header" onClick={onToggleCollapse}>
          <span className={`bets-workspace__chevron${collapsed ? ' is-collapsed' : ''}`}>▾</span>
          <span className="bets-workspace__section-title">Arb Screener</span>
          <span className="bets-workspace__section-count">{games === null ? '…' : count > 0 ? `${count} to work` : 'nothing yet'}</span>
        </button>
      </div>
      {!collapsed && (
        <div className="bets-arb__body">
          <p className="bets-arb__intro text-muted">
            DraftKings lines via ESPN. Promo plays assume the promo book's price is close to DK's — open one to type the real odds before you bet.
          </p>

          {games === null && <div className="bets-arb__empty text-muted">Loading the day's lines…</div>}
          {note && <div className="bets-arb__empty text-muted">{note}</div>}

          {boardArbs.length > 0 && (
            <div className="bets-arb__group">
              <div className="bets-arb__group-title">On your board</div>
              {boardArbs.map(({ matchup, sport, arb }) => (
                <div key={`${sport}:${matchup}`} className="bets-arb__board">
                  <span className="bets-arb__game">
                    {sport} · {matchup}
                  </span>
                  <span className="bets-arb__board-legs">
                    {arb.books.map((book, i) => (
                      <span key={book} className="bets-arb__board-leg">
                        <BookBadge book={book} /> {formatAmerican(arb.cells[i].price)} ({formatMoney(arb.result.legs[i].stake)})
                      </span>
                    ))}
                  </span>
                  <span className="bets-arb__profit">{pct(arb.margin)} locked</span>
                </div>
              ))}
            </div>
          )}

          {games !== null && (
            <div className="bets-arb__group">
              <div className="bets-arb__group-title">Promo plays</div>
              {promos.length === 0 && <div className="bets-arb__empty text-muted">No active promos today — add boosts or free bets in Promos and they'll be matched here.</div>}
              {promos.length > 0 && plays.length === 0 && priced > 0 && (
                <div className="bets-arb__empty text-muted">None of today's active promos lock a profit against today's lines.</div>
              )}
              {plays.map((play) => (
                <PlayRow key={play.id} play={play} />
              ))}
              {skipped.length > 0 && (
                <div className="bets-arb__skipped text-muted">
                  Not matched:{' '}
                  {skipped.map((f, i) => (
                    <span key={f.promo.id}>
                      {i > 0 && ' · '}
                      {f.promo.sportsbook} {f.promo.description} ({f.reason})
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {spots.length > 0 && (
            <div className="bets-arb__group">
              <div className="bets-arb__group-title">Closest to an arb · smallest boost needed</div>
              <div className="bets-workspace__table-wrap">
                <table className="bets-arb__spots">
                  <thead>
                    <tr>
                      <th>Game</th>
                      <th>Best spot (other side at DK)</th>
                      <th>Min boost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownSpots.map((spot) => (
                      <SpotRow key={`${spot.game.sport}:${spot.game.eventId}`} spot={spot} clearedBy={clearing(spot)} />
                    ))}
                  </tbody>
                </table>
              </div>
              {spots.length > SPOTS_SHOWN && (
                <button type="button" className="chip bets-arb__more" onClick={() => setShowAllSpots((v) => !v)}>
                  {showAllSpots ? 'Show fewer' : `Show all ${spots.length}`}
                </button>
              )}
            </div>
          )}
          {games !== null && priced === 0 && !note && <div className="bets-arb__empty text-muted">No lines posted yet for this date.</div>}
        </div>
      )}
    </div>
  );
}

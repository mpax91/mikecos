import { useMemo, useState, type ReactNode } from 'react';
import type { BetPromo } from '../api/types';
import { formatExpiryLabel, sportsbookBrand } from '../utils/bets';

/** Small stroke icon per sport, so the Sport column reads at a glance.
 * Anything without its own glyph gets a plain dot. */
export function SportIcon({ sport }: { sport: string }) {
  const common = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', strokeWidth: 1.9, strokeLinecap: 'round' as const, 'aria-hidden': true };
  switch (sport) {
    case 'MLB':
      return (
        <svg {...common} stroke="#B4442F">
          <circle cx="12" cy="12" r="9" />
          <path d="M7 5.5c1.8 1.8 2.6 4 2.6 6.5S8.8 16.7 7 18.5" />
          <path d="M17 5.5c-1.8 1.8-2.6 4-2.6 6.5s.8 4.7 2.6 6.5" />
        </svg>
      );
    case 'NHL':
      return (
        <svg {...common} stroke="#2C5A8C">
          <ellipse cx="12" cy="9" rx="9" ry="3.5" />
          <path d="M3 9v5c0 1.9 4 3.5 9 3.5s9-1.6 9-3.5V9" />
        </svg>
      );
    case 'NFL':
    case 'NCAAF':
      return (
        <svg {...common} stroke="#7A4A22">
          <path d="M4 20C3 13 7 4 20 4c1 7-3 16-16 16z" />
          <path d="M9 15l6-6M10.5 10.5l3 3M12.5 8.5l3 3M8.5 12.5l3 3" />
        </svg>
      );
    case 'NBA':
    case 'NCAAB':
      return (
        <svg {...common} stroke="#C2601A">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3v18" />
          <path d="M5.6 5.6c2.6 2.6 2.6 10.2 0 12.8M18.4 5.6c-2.6 2.6-2.6 10.2 0 12.8" />
        </svg>
      );
    default:
      return (
        <svg {...common} stroke="#6E6250">
          <circle cx="12" cy="12" r="4" />
        </svg>
      );
  }
}

const FILTER_KEY = 'mikeos.betPromoFilters';

function loadFilters(): { book: string; sport: string } {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      return { book: typeof v.book === 'string' ? v.book : '', sport: typeof v.sport === 'string' ? v.sport : '' };
    }
  } catch {
    /* storage unavailable — start unfiltered */
  }
  return { book: '', sport: '' };
}

function saveFilters(f: { book: string; sport: string }) {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(f));
  } catch {
    /* ignore */
  }
}

/** Shared filter state + header pills for the promos table. The sport
 * filter keeps promos with no sport (bonus bets, any-sport boosts) since
 * they apply to whatever sport is picked. */
export function usePromoFilters(promos: BetPromo[]) {
  const [filters, setFiltersState] = useState(loadFilters);
  const setFilters = (f: { book: string; sport: string }) => {
    setFiltersState(f);
    saveFilters(f);
  };
  const books = useMemo(() => [...new Set(promos.map((p) => p.sportsbook))].sort(), [promos]);
  const sports = useMemo(() => [...new Set(promos.map((p) => p.sport).filter((s): s is string => !!s))].sort(), [promos]);
  // A remembered filter for a book/sport with no promos right now would
  // hide everything with no visible reason — ignore it until it reappears.
  const book = books.includes(filters.book) ? filters.book : '';
  const sport = sports.includes(filters.sport) ? filters.sport : '';
  const shown = promos.filter((p) => (!book || p.sportsbook === book) && (!sport || !p.sport || p.sport === sport));
  return { book, sport, books, sports, shown, setFilters };
}

export function PromoFilterPills({ f }: { f: ReturnType<typeof usePromoFilters> }) {
  return (
    <div className="bets-promos__filters" onClick={(e) => e.stopPropagation()}>
      <select
        aria-label="Filter by sportsbook"
        className={`bets-promos__pill${f.book ? ' is-on' : ''}`}
        value={f.book}
        onChange={(e) => f.setFilters({ book: e.target.value, sport: f.sport })}
      >
        <option value="">All Sportsbooks</option>
        {f.books.map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </select>
      <select
        aria-label="Filter by sport"
        className={`bets-promos__pill${f.sport ? ' is-on' : ''}`}
        value={f.sport}
        onChange={(e) => f.setFilters({ book: f.book, sport: e.target.value })}
      >
        <option value="">All Sports</option>
        {f.sports.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      {(f.book || f.sport) && (
        <button type="button" className="bets-promos__clear" onClick={() => f.setFilters({ book: '', sport: '' })}>
          Clear
        </button>
      )}
    </div>
  );
}

function maxBetLabel(v: number | null): string | null {
  if (v == null) return null;
  return `$${Number.isInteger(v) ? v : v.toFixed(2)}`;
}

/** The aligned-columns promos table: every detail in a fixed column so the
 * same fact sits in the same place on every row. Missing requirements read
 * "Any" rather than a dash. */
export function BetsPromosTable({
  promos,
  today,
  emptyLabel = 'No promos match these filters.',
  renderStatus,
  renderActions,
}: {
  promos: BetPromo[];
  today: string;
  emptyLabel?: string;
  /** Promos tab only: a status column and a ⋯ menu per row. */
  renderStatus?: (p: BetPromo) => ReactNode;
  renderActions?: (p: BetPromo) => ReactNode;
}) {
  const extra = renderStatus || renderActions ? ' bets-promos__table--managed' : '';
  if (promos.length === 0) return <div className="bets-promos__empty">{emptyLabel}</div>;
  return (
    <div className="bets-promos__scroll">
      <div className={`bets-promos__table${extra}`} role="table">
        <div className="bets-promos__row bets-promos__row--head" role="row">
          <span role="columnheader">Sportsbook</span>
          <span role="columnheader">Sport</span>
          <span role="columnheader">Description</span>
          <span role="columnheader">Value</span>
          <span role="columnheader">Min Odds</span>
          <span role="columnheader">Legs</span>
          <span role="columnheader">Max Bet</span>
          <span role="columnheader" className="bets-promos__right">
            Expires
          </span>
          {extra && <span role="columnheader">Status</span>}
          {extra && <span role="columnheader" aria-label="Actions" />}
        </div>
        {promos.map((p) => {
          const brand = sportsbookBrand(p.sportsbook);
          const maxBet = maxBetLabel(p.max_bonus);
          return (
            <div key={p.id} className="bets-promos__row" role="row">
              <span role="cell" className="bets-promos__book">
                <span className="bets-promos__badge" style={{ background: brand.color }}>
                  {brand.mono}
                </span>
                {p.sportsbook}
              </span>
              <span role="cell" className="bets-promos__sport">
                {p.sport ? (
                  <>
                    <SportIcon sport={p.sport} />
                    {p.sport}
                  </>
                ) : (
                  <span className="bets-promos__any">Any Sport</span>
                )}
              </span>
              <span role="cell" className="bets-promos__desc">
                {p.description || <span className="bets-promos__any">—</span>}
              </span>
              <span role="cell" className="bets-promos__value">
                {p.amount && <span className="bets-promos__value-num">{p.amount}</span>}
                <span className={p.amount ? 'bets-promos__value-type' : 'bets-promos__value-num bets-promos__value-num--type'}>{p.promo_type}</span>
              </span>
              <span role="cell" className={p.odds ? 'bets-promos__num' : 'bets-promos__any'}>
                {p.odds ?? 'Any'}
              </span>
              <span role="cell" className={p.legs ? 'bets-promos__num' : 'bets-promos__any'}>
                {p.legs ? `${p.legs} Legs` : 'Any'}
              </span>
              <span role="cell" className={maxBet ? 'bets-promos__num' : 'bets-promos__any'}>
                {maxBet ?? '—'}
              </span>
              <span role="cell" className="bets-promos__right">
                {p.expires_at ? (
                  <span className={`bets-promos__expiry${p.expires_at <= today ? ' is-today' : ''}`}>{formatExpiryLabel(p.expires_at, today)}</span>
                ) : (
                  <span className="bets-promos__any">No Expiry</span>
                )}
              </span>
              {extra && <span role="cell">{renderStatus?.(p)}</span>}
              {extra && <span role="cell">{renderActions?.(p)}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

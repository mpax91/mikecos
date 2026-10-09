import { Link } from 'react-router-dom';
import type { CardRewards, RewardsOverview } from '../api/types';

const money = (n: number, cents = true) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

/** Cash back on a credit-card dashboard (any card template — rewards.ts
 * shape): available / earned / redeemed, cash back by calendar year with
 * the % back, and the redeem reminder's state. */
export function CardRewardsPanel({
  rewards: r,
  redeemAt,
  redeemTask,
  redeemQuietUntil,
  color,
}: {
  rewards: CardRewards;
  redeemAt: number;
  redeemTask: { id: string; title: string; due: string | null } | null;
  redeemQuietUntil: number | null;
  color: string;
}) {
  const years = [...r.years].reverse();
  const max = Math.max(1, ...years.map((y) => y.earned));
  const cy = years.find((y) => y.current)?.year ?? new Date().getFullYear();
  const pts = (n: number) => Math.round(n).toLocaleString('en-US');
  const availableSub =
    r.unit === 'points' && r.availablePoints !== null ? `${pts(r.availablePoints)} points` : r.asOf ? `As of ${fmtDate(r.asOf)}` : null;

  return (
    <section className="fin-dash__card">
      <h3 className="fin-dash__card-title">Cash Back by Year</h3>
      <div className="rewards__totals">
        <Total label="Available Now" value={r.available !== null ? money(r.available) : '—'} sub={availableSub} />
        <Total label={`Earned ${cy}`} value={money(r.earnedYtd)} />
        <Total label="Earned All-Time" value={money(r.earnedAllTime, false)} sub={r.since ? `Since ${r.since.slice(0, 4)}` : null} />
        <Total label="Redeemed All-Time" value={money(r.redeemedAllTime, false)} />
      </div>

      {years.length ? (
        <div className="fin-dash__years rewards__years">
          {years.map((y) => (
            <div
              key={y.year}
              className="fin-dash__year rewards__year"
              title={`${y.year}: ${money(y.earned)} cash back on ${money(y.net)} of net spending (${y.statements} statement${y.statements === 1 ? '' : 's'})${y.partial && !y.current ? ' — estimated: statements missing or a partial year' : ''}`}
            >
              <span className="fin-dash__year-label">{y.year}</span>
              <span className="fin-dash__year-track">
                <span className="fin-dash__year-bar" style={{ width: `${Math.max(0, (y.earned / max) * 100)}%`, background: color }} />
              </span>
              <span className="fin-dash__year-value">
                {y.partial && !y.current ? '≈' : ''}
                {money(y.earned, false)}
              </span>
              <span className="fin-dash__year-bills">{y.current ? 'YTD' : y.rate !== null ? `${y.rate.toFixed(1)}%` : ''}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="fin-dash__muted">No cash back on these statements yet.</p>
      )}

      <p className="rewards__redeem">
        {redeemTask ? (
          <>
            <span aria-hidden="true">🔔 </span>
            Task open: <strong>{redeemTask.title}</strong>
          </>
        ) : redeemAt > 0 ? (
          <>
            Redeem reminder at {money(redeemAt, false)}
            {redeemQuietUntil !== null ? ` — snoozed until ${money(redeemQuietUntil, false)} (you closed the last one)` : ''}.{' '}
          </>
        ) : (
          <>Redeem reminder off. </>
        )}
        {!redeemTask && <Link to="/settings?cat=statements">Change</Link>}
      </p>
      <p className="fin-dash__note">
        Years go by statement closing date. % = cash back ÷ net spending.{r.unit === 'points' ? ` Points at ${r.pointsPerDollar} per $1.` : ''}
        {years.some((y) => y.partial && !y.current) ? ' ≈ = estimated (a partial year or statements missing from Drive).' : ''}
      </p>
    </section>
  );
}

function Total({ label, value, sub }: { label: string; value: string; sub?: string | null }) {
  return (
    <div className="rewards__total">
      <span className="rewards__total-label">{label}</span>
      <span className="rewards__total-value">{value}</span>
      {sub && <span className="rewards__total-sub">{sub}</span>}
    </div>
  );
}

/** Finance page: cash back across every live card for the owner tab —
 * totals and a calendar-year table with each card's share. */
export function FinanceRewardsCard({ data }: { data: RewardsOverview | null }) {
  if (!data || !data.cards.length) return null;
  const cy = new Date().getFullYear();
  const multi = data.cards.length > 1;
  const nameOf = (id: string) => data.cards.find((c) => c.folderId === id)?.name ?? '';
  const open = data.cards.filter((c) => c.redeemAt > 0 && c.rewards.available !== null && c.rewards.available >= c.redeemAt);
  return (
    <section className="cash-place finance-rewards" aria-label="Card Rewards">
      <div className="cash-place__head">
        <h2 className="cash-place__title">Card Rewards</h2>
        {open.length > 0 && <span className="cash-place__total">Ready to redeem: {open.map((c) => c.name).join(', ')}</span>}
      </div>
      <div className="rewards__totals rewards__totals--row">
        <Total label="Available Now" value={money(data.available)} sub={multi ? data.cards.map((c) => `${c.name} ${money(c.rewards.available ?? 0)}`).join(' · ') : null} />
        <Total label={`Earned ${cy}`} value={money(data.earnedYtd)} />
        <Total label="Earned All-Time" value={money(data.earnedAllTime, false)} />
        <Total label="Redeemed All-Time" value={money(data.redeemedAllTime, false)} />
      </div>
      <div className="fin-dash__table-wrap">
        <table className="fin-dash__table rewards__table">
          <thead>
            <tr>
              <th>Year</th>
              {multi && data.cards.map((c) => <th key={c.folderId} className="rewards__num rewards__card-col">{c.name}</th>)}
              <th className="rewards__num">Cash Back</th>
              <th className="rewards__num">Spending</th>
              <th className="rewards__num">% Back</th>
            </tr>
          </thead>
          <tbody>
            {data.years.map((y) => (
              <tr key={y.year} title={y.partial && !y.current ? 'Estimated — a statement is missing from Drive for part of this year' : undefined}>
                <td>
                  {y.year}
                  {y.current ? <span className="fin-dash__muted"> YTD</span> : ''}
                </td>
                {multi &&
                  data.cards.map((c) => {
                    const v = y.byCard.find((b) => b.folderId === c.folderId);
                    return (
                      <td key={c.folderId} className="rewards__num rewards__card-col" title={v ? `${nameOf(c.folderId)} ${y.year}` : undefined}>
                        {v ? money(v.earned) : '—'}
                      </td>
                    );
                  })}
                <td className="rewards__num">
                  <strong>
                    {y.partial && !y.current ? '≈' : ''}
                    {money(y.earned)}
                  </strong>
                </td>
                <td className="rewards__num">{money(y.net, false)}</td>
                <td className="rewards__num">{y.rate !== null ? `${y.rate.toFixed(2)}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fin-dash__note">
        Cash back earned on each card’s statements, by statement closing year (points at their cash value). Not taxable income.
        {data.years.some((y) => y.partial && !y.current) ? ' ≈ = estimated (statements missing from Drive).' : ''}
      </p>
    </section>
  );
}

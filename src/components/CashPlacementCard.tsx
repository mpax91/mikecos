import { Link } from 'react-router-dom';
import type { CashBankPlacement, CashPlacement, CashSuggestion } from '../api/types';

/** Cash Placement (worker statements/cashPlacement.ts) — rule-based, no AI.
 * `CashPlacementCard` sits on Finance and shows only when a suggestion has
 * held for 2 statements; `CashPlacementDetail` is the always-on card on a
 * bank's dashboard that shows the math behind it. Mike moves money himself. */

const money0 = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n.toFixed(2)}%`);
const toMs = (iso: string) => Date.parse(`${iso}T12:00:00`);
const fmtDate = (iso: string) => new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtMonth = (iso: string) => new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

function SuggestionRow({ s, linked }: { s: CashSuggestion; linked: boolean }) {
  const from = s.kind === 'idle' ? s.fromLabel : `${s.bank} ${s.fromLabel}`;
  const to = s.kind === 'idle' ? s.toLabel : `${s.toBank} ${s.toLabel}`;
  return (
    <li className="cash-place__item">
      <div className="cash-place__move">
        <span className="cash-place__amount">Move {money0(s.amount)}</span>
        <span className="cash-place__path">
          {from} → {to}
        </span>
        <span className="cash-place__why">
          {pct(s.toApy)} vs {pct(s.fromApy)} APY earned
          {s.kind === 'idle' && s.buffer !== undefined ? ` · Keeps a ${money0(s.buffer)} checking buffer` : ''}
          {s.fdicCapped ? ' · Capped at the $250K FDIC limit' : ''}
          {` · Held since ${fmtDate(s.heldSince)}`}
        </span>
      </div>
      <div className="cash-place__gain">
        <span className="cash-place__gain-value">+{money0(s.gainPerYear)}</span>
        <span className="cash-place__gain-label">per year</span>
        {linked && (
          <Link to={`/finance/${s.folderId}`} className="cash-place__link">
            Details ›
          </Link>
        )}
      </div>
    </li>
  );
}

/** Finance page card — hidden when nothing qualifies for this owner. */
export function CashPlacementCard({ data, owner }: { data: CashPlacement | null; owner: string | null }) {
  const shown = (data?.suggestions ?? []).filter((s) => s.owner === owner);
  if (!data || shown.length === 0) return null;
  const total = shown.reduce((t, s) => t + s.gainPerYear, 0);
  return (
    <section className="cash-place" aria-label="Cash Placement">
      <div className="cash-place__head">
        <h2 className="cash-place__title">Cash Placement</h2>
        {shown.length > 1 && <span className="cash-place__total">+{money0(total)}/yr total</span>}
      </div>
      <ul className="cash-place__list">
        {shown.map((s) => (
          <SuggestionRow key={s.id} s={s} linked />
        ))}
      </ul>
      <p className="cash-place__note">
        From your statements: suggested only after holding for 2 statements in a row and worth at least {money0(data.rules.minIdleGain)}/yr ({money0(data.rules.minMoveGain)}/yr between banks).
        You move the money yourself.
      </p>
    </section>
  );
}

const STATUS_TEXT: Record<CashBankPlacement['status'], string> = {
  suggest: 'Worth moving — see above.',
  not_held: 'Above the buffer on the latest statement only — suggested if it holds on the next one.',
  below_threshold: 'Some cash sits above the buffer, but moving it would earn under the minimum.',
  no_idle: 'Nothing to move — checking is at or under its buffer.',
  no_savings: 'No savings account with a rate to compare against.',
  insufficient_history: 'Needs at least 6 statements with activity to size the buffer.',
  stale: 'The latest statement is over 60 days old — waiting for a new one.',
};

/** Dashboard card: the numbers behind the suggestion, always shown. */
/** `savingsOnly`: a bank with no checking (American Express) — only the
 * cross-bank savings rule applies, so the checking-buffer facts are hidden. */
export function CashPlacementDetail({
  bank,
  suggestions,
  rules,
  savingsOnly,
}: {
  bank: CashBankPlacement | null;
  suggestions: CashSuggestion[];
  rules: CashPlacement['rules'];
  savingsOnly?: { label: string; apy: number | null };
}) {
  if (savingsOnly) {
    return (
      <section className="fin-dash__card fin-dash__card--full cash-place-detail">
        <h3 className="fin-dash__card-title">Cash Placement</h3>
        {suggestions.length > 0 && (
          <ul className="cash-place__list cash-place__list--compact">
            {suggestions.map((s) => (
              <SuggestionRow key={s.id} s={s} linked={false} />
            ))}
          </ul>
        )}
        <p className="cash-place-detail__status">
          {suggestions.length
            ? 'The suggestion above has held for 2 statements in a row.'
            : `No move suggested between ${savingsOnly.label} (${pct(savingsOnly.apy)}) and your other banks’ savings right now.`}
        </p>
        <p className="fin-dash__note">
          Savings only, so there’s no checking buffer here. Across banks, a move is suggested when another bank’s savings APY beats this one by at least {money0(rules.minMoveGain)}/yr on the
          balance for 2 statements in a row, never pushing a bank over the {money0(rules.fdicLimit)} FDIC limit.
        </p>
      </section>
    );
  }
  const c = bank?.current ?? null;
  return (
    <section className="fin-dash__card fin-dash__card--full cash-place-detail">
      <h3 className="fin-dash__card-title">Cash Placement</h3>
      {suggestions.length > 0 && (
        <ul className="cash-place__list cash-place__list--compact">
          {suggestions.map((s) => (
            <SuggestionRow key={s.id} s={s} linked={false} />
          ))}
        </ul>
      )}
      {c ? (
        <dl className="cash-place-detail__facts">
          <dt>Checking Buffer</dt>
          <dd>{money0(c.buffer)}</dd>
          <dt className="cash-place-detail__sub">Median Month Out</dt>
          <dd className="cash-place-detail__sub">{money0(c.medianOutflow)}</dd>
          <dt className="cash-place-detail__sub">Biggest Month Out</dt>
          <dd className="cash-place-detail__sub">
            {money0(c.largestOutflow)}
            {c.largestMonth ? ` · ${fmtMonth(c.largestMonth)}` : ''}
          </dd>
          <dt>Average Checking Balance</dt>
          <dd>{money0(c.avgBalance)}</dd>
          <dt>Idle Cash</dt>
          <dd>{money0(c.idle)}</dd>
          <dt>APY Earned</dt>
          <dd>
            {c.savings ? `${c.savings.label} ${pct(c.savings.apy)} · ` : ''}
            {c.checking.label} {pct(c.checking.apy)}
          </dd>
          <dt>Estimated Gain</dt>
          <dd>{money0(c.gainPerYear)}/yr</dd>
        </dl>
      ) : null}
      <p className="cash-place-detail__status">{bank ? STATUS_TEXT[bank.status] : 'Not available yet.'}</p>
      <p className="fin-dash__note">
        Buffer = the bigger of the median and the largest month of money leaving checking over the last {rules.bufferMonths} statements, plus {rules.cushionPct}%. Idle cash = the
        average checking balance over the last 3 statements minus the buffer. Transfers between your own accounts don’t count as money out.
      </p>
    </section>
  );
}

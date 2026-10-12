import type { CardPaypalPanel as Data } from '../api/types';
import { DashTitle } from './dash/InfoTip';

const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** On a credit card dashboard: the real stores behind this card's
 * "PAYPAL *…" charges, matched from the PayPal statements (paypalMatch.ts). */
export function CardPaypalPanel({ data }: { data: Data | null }) {
  if (!data || (!data.matched && !data.unmatched)) return null;
  const max = Math.max(1, ...data.merchants.map((m) => m.total));
  return (
    <section className="fin-dash__card">
      <DashTitle
        info={
          <p>
            This card’s “PAYPAL *…” charges, matched to the PayPal statement row with the same amount 0–5 days earlier — so you see the real store. Unmatched ones are PayPal charges with no PayPal
            statement row yet (or from another PayPal account).
          </p>
        }
      >
        Paid Through PayPal
      </DashTitle>
      {data.merchants.length ? (
        <div className="fin-dash__years paypal-dash__bars paypal-dash__bars--wide">
          {data.merchants.map((m) => (
            <div key={m.name} className="fin-dash__year">
              <span className="fin-dash__year-label" title={m.name}>
                {m.name}
              </span>
              <span className="fin-dash__year-track">
                <span className="fin-dash__year-bar" style={{ width: `${(Math.max(0, m.total) / max) * 100}%` }} />
              </span>
              <span className="fin-dash__year-value">{money(m.total)}</span>
              <span className="fin-dash__year-bills">{m.count}×</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="fin-dash__muted">No PayPal charges on this card matched yet.</p>
      )}
      <p className="fin-dash__stat-sub">
        {data.matched} matched{data.unmatched ? ` · ${data.unmatched} not matched (${money(data.unmatchedTotal)})` : ''}
      </p>
    </section>
  );
}

/** The "via PayPal · <store>" line under a card transaction's description. */
export function ViaPaypal({ store }: { store?: string }) {
  return store ? <span className="paypal-dash__via">via PayPal · {store}</span> : null;
}

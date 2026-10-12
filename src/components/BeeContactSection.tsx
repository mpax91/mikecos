import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { BeeContactInfo, MerchContactInfo } from '../api/types';

/** Collapsed "Bedford Bee" bar on a contact card (same look as Voter
 * Insight): plan + Spotlight badges in the bar, subscription and
 * engagement details inside. Only for current subscribers. */

const toDate = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
};
const fmt = (iso: string | null) => (iso && /^\d{4}-\d\d-\d\d/.test(iso) ? toDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : iso);

function Tile({ label, value, wide }: { label: string; value: string | number | null | undefined; wide?: boolean }) {
  if (value == null || value === '') return null;
  return (
    <div className={`voter-tile${wide ? ' voter-tile--wide' : ''}`}>
      <div className="voter-tile__label">{label}</div>
      <div className="voter-tile__value">{value}</div>
    </div>
  );
}

export function BeeContactSection({ bee }: { bee: BeeContactInfo | null | undefined }) {
  const [open, setOpen] = useState(false);
  if (!bee) return null;
  const e = bee.engagement;
  const plan = bee.type?.replace(' Subscriber', '') ?? 'Subscriber';
  return (
    <div className={`voter-insight bee-contact${open ? ' is-open' : ''}`}>
      <button type="button" className="voter-insight__header" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="voter-insight__caret" aria-hidden>
          ›
        </span>
        <span className="voter-insight__title">Bedford Bee</span>
        <span className="voter-insight__summary">
          <span className={`bee-badge${bee.paid ? ' bee-badge--paid' : ''}`}>{plan}</span>
          {e?.forwarder && <span className="bee-badge bee-badge--fwd">{e.forwarder === 'burst' ? 'Burst Forwarder' : 'Steady Forwarder'}</span>}
          {e?.superfan && <span className="bee-badge">Superfan</span>}
          {e && e.superfan && !bee.paid && <span className="bee-badge bee-badge--muted">Upgrade Candidate</span>}
        </span>
        <span className="voter-insight__toggle">{open ? 'Hide Details' : 'Show Details'}</span>
      </button>
      {open && (
        <div className="voter-insight__card">
          <div className="voter-insight__body">
            <div className="voter-insight__group-title">Subscription</div>
            <div className="voter-tiles">
              <Tile label="Plan" value={bee.plan ? `${plan} · ${bee.plan}` : plan} />
              <Tile label="Subscriber Since" value={fmt(bee.startDate)} />
              <Tile label="First Paid" value={fmt(bee.firstPaidDate)} />
              <Tile label={bee.cancelled ? 'Cancelled · Ends' : 'Renews'} value={bee.expires && !/never/i.test(bee.expires) ? fmt(bee.expires) : bee.paid ? 'Never (lifetime)' : null} />
              <Tile label="Paid to Date" value={bee.revenue ? `$${bee.revenue.toFixed(2)}` : null} />
              <Tile label="Came From" value={bee.source ? bee.source.charAt(0).toUpperCase() + bee.source.slice(1) : null} />
              <Tile label="Email" value={bee.email} wide />
            </div>
            {e && (
              <>
                <div className="voter-insight__group-title">Engagement (Last 6 Months)</div>
                <div className="voter-tiles">
                  <Tile label="Emails Read" value={`${e.seen6mo ?? 0} of ${e.received6mo ?? 0}`} />
                  <Tile label="Opens per Email" value={e.ratio === null ? null : `${e.ratio.toFixed(1)}×`} />
                  <Tile label="Engagement Score" value={`${e.score} / 100`} />
                  <Tile label="Clicks" value={e.clicks ?? 0} />
                  <Tile label="Shares · Comments" value={`${e.shares ?? 0} · ${e.comments ?? 0}`} />
                  <Tile label="Last Open" value={fmt(e.lastOpen)} />
                </div>
                {e.forwarder && e.inflated && (
                  <p className="fin-dash__note">
                    {e.inflated === 'work' ? 'Work email — a security scanner can add opens.' : 'Apple Mail — automatic opens and several devices can add opens.'}
                  </p>
                )}
              </>
            )}
            <p className="fin-dash__note">
              From the Substack exports · <Link to="/bee?tab=substack">Bedford Bee dashboard</Link>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Collapsed "Merch" bar: orders from the Bedford Bee merch store
 * (Fourthwall). Only for people who bought something. */
export function MerchContactSection({ merch }: { merch: MerchContactInfo | null | undefined }) {
  const [open, setOpen] = useState(false);
  if (!merch) return null;
  return (
    <div className={`voter-insight bee-contact${open ? ' is-open' : ''}`}>
      <button type="button" className="voter-insight__header" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="voter-insight__caret" aria-hidden>
          ›
        </span>
        <span className="voter-insight__title">Bee Merch</span>
        <span className="voter-insight__summary">
          <span className="bee-badge">
            {merch.orders} Order{merch.orders === 1 ? '' : 's'} · {usd(merch.spent)}
          </span>
        </span>
        <span className="voter-insight__toggle">{open ? 'Hide Details' : 'Show Details'}</span>
      </button>
      {open && (
        <div className="voter-insight__card">
          <div className="voter-insight__body">
            <div className="voter-tiles">
              <Tile label="Orders" value={merch.orders} />
              <Tile label="Paid in All" value={usd(merch.spent)} />
              <Tile label="First Order" value={fmt(merch.first)} />
              <Tile label="Last Order" value={merch.last !== merch.first ? fmt(merch.last) : null} />
            </div>
            <div className="voter-insight__group-title">Orders</div>
            <ul className="bee-list">
              {merch.list.map((o) => (
                <li key={o.id} className="bee-list__row">
                  <span>
                    {fmt(o.day)}
                    {o.items.length ? ` · ${o.items.join(', ')}` : ''}
                  </span>
                  <span className="bee-list__meta">{usd(o.total)}</span>
                </li>
              ))}
            </ul>
            <p className="fin-dash__note">
              From the Fourthwall store · <Link to="/bee?tab=merch">Merch dashboard</Link>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

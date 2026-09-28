import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { PaymentCard, WalletCard } from '../api/types';
import { isPhoneLabel, telHref } from '../utils/phone';

type Kind = 'payment' | 'loyalty';

// WalletCardFact and PaymentCardFact are structurally identical (see their
// own comments in api/types.ts — same shape on purpose, so this modal can
// treat a phone number the same regardless of which card type it's on).
interface Fact {
  id: string;
  label: string;
  value: string | null;
}

interface Row {
  key: string;
  kind: Kind;
  name: string;
  subtitle: string;
  phoneFacts: Fact[];
}

/** "Lost my wallet?" — Mike's own framing when asked how this should work
 * (not either of the two smart-default options offered, a full audit over
 * every card instead): "a menu that asks me to check off which cards were
 * and were not in my wallet. Or maybe it's easier if I just check to see
 * which cards I have vs ones I'm missing." So every Payment Card and every
 * Loyalty/ID card starts unconfirmed here — ticking a card off means "I
 * have this one, it's safe" — and whatever's still unticked is treated as
 * missing, with its "Phone #" Details fact(s) surfaced as tel: links to
 * call for cancel/replace. Nothing here is saved anywhere; it's a one-time
 * working checklist for the moment right after losing a wallet, not a
 * standing "always in my wallet" flag on each card. */
export function LostWalletModal({ onClose }: { onClose: () => void }) {
  const [payment, setPayment] = useState<PaymentCard[] | null>(null);
  const [loyalty, setLoyalty] = useState<WalletCard[] | null>(null);
  const [factsByCard, setFactsByCard] = useState<Map<string, Fact[]>>(new Map());
  const [have, setHave] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');

  useEffect(() => {
    api.listPaymentCards().then((cards) => setPayment(cards.filter((c) => c.active)));
    api.listWalletCards().then(setLoyalty);
  }, []);

  useEffect(() => {
    if (!payment || !loyalty) return;
    // Details facts aren't included on the list responses (same
    // lazy-loaded pattern as everywhere else Details renders), so pull
    // each card's facts once everything's loaded, purely to find any
    // "Phone #"-labeled ones for the missing-cards call list below.
    Promise.all([
      ...payment.map((c) => api.listPaymentCardFacts(c.id).then((facts) => [`payment:${c.id}`, facts] as const)),
      ...loyalty.map((c) => api.listWalletCardFacts(c.id).then((facts) => [`loyalty:${c.id}`, facts] as const)),
    ]).then((entries) => setFactsByCard(new Map(entries)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payment, loyalty]);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const c of payment ?? []) {
      const key = `payment:${c.id}`;
      out.push({
        key,
        kind: 'payment',
        name: c.nickname,
        subtitle: [c.cardType === 'debit' ? 'Debit' : 'Credit', c.network, c.last4 ? `••${c.last4}` : null].filter(Boolean).join(' · '),
        phoneFacts: (factsByCard.get(key) ?? []).filter((f) => f.value && isPhoneLabel(f.label)),
      });
    }
    for (const c of loyalty ?? []) {
      const key = `loyalty:${c.id}`;
      out.push({
        key,
        kind: 'loyalty',
        name: c.name,
        subtitle: c.category,
        phoneFacts: (factsByCard.get(key) ?? []).filter((f) => f.value && isPhoneLabel(f.label)),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [payment, loyalty, factsByCard]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(q) || r.subtitle.toLowerCase().includes(q));
  }, [rows, query]);

  const missing = useMemo(() => rows.filter((r) => !have.has(r.key)), [rows, have]);

  function toggle(key: string) {
    setHave((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const loading = payment === null || loyalty === null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h3 style={{ margin: 0 }}>Lost my wallet</h3>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="wallet-editor__body">
          <div className="wallet-editor__hint" style={{ marginBottom: 10 }}>
            Check off each card as you confirm you still have it. Anything left unchecked is treated as missing — its
            phone number (if you've saved one under "Phone #" in Details) shows below to call for cancel/replace.
            Nothing here is saved; it's just a working checklist.
          </div>

          {loading ? (
            <div className="empty-state">Loading your cards…</div>
          ) : rows.length === 0 ? (
            <div className="empty-state">No cards on file yet.</div>
          ) : (
            <>
              <input
                type="search"
                className="wallet-page__search"
                placeholder="Filter cards…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />

              <div className="wallet-page__section" style={{ marginTop: 10 }}>
                <div className="wallet-page__section-title">
                  {have.size} of {rows.length} confirmed
                </div>
                <div className="lost-wallet__rows">
                  {filtered.map((r) => (
                    <label key={r.key} className="lost-wallet__row">
                      <input type="checkbox" checked={have.has(r.key)} onChange={() => toggle(r.key)} />
                      <span className="lost-wallet__row-name">{r.name}</span>
                      <span className="lost-wallet__row-sub">{r.subtitle}</span>
                    </label>
                  ))}
                </div>
              </div>

              {missing.length > 0 && (
                <div className="wallet-page__section">
                  <div className="wallet-page__section-title">Missing — call these</div>
                  <div className="lost-wallet__missing">
                    {missing.map((r) => (
                      <div key={r.key} className="lost-wallet__missing-row">
                        <div>
                          <div className="lost-wallet__row-name">{r.name}</div>
                          <div className="lost-wallet__row-sub">{r.subtitle}</div>
                        </div>
                        <div className="lost-wallet__missing-phones">
                          {r.phoneFacts.length === 0 ? (
                            <span className="lost-wallet__no-phone">No phone number on file</span>
                          ) : (
                            r.phoneFacts.map((f) => {
                              const tel = telHref(f.value!);
                              return tel ? (
                                <a key={f.id} href={tel} className="wallet-barcode-view__details-tel">
                                  {f.value}
                                </a>
                              ) : (
                                <span key={f.id}>{f.value}</span>
                              );
                            })
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

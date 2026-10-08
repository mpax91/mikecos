import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { BankAccountSuggestion, PaymentCard } from '../api/types';
import { PaymentCardTile } from './PaymentCardTile';
import { PaymentCardDetail } from './PaymentCardDetail';
import { PaymentCardEditor } from './PaymentCardEditor';
import { BankAccountEditor } from './BankAccountEditor';
import { BANK_KIND_LABEL } from '../utils/bankAccount';
import { ConfirmModal } from './ConfirmModal';

/** Wallet Phase 3 — a secure Payment Cards vault (credit and debit both;
 * see 0049_payment_cards.sql for why the scope widened from "credit cards"
 * to "payment cards"). Deliberately flat, no sub-tabs — unlike Rewards,
 * there's no "which one should I use" question here, just a catalogue. A
 * card flagged reward-worthy shows a star and links to its Rewards entry,
 * but never gets a second, duplicate row there. */
export function PaymentCardsPanel() {
  const location = useLocation();
  const navigate = useNavigate();

  const [cards, setCards] = useState<PaymentCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openCard, setOpenCard] = useState<PaymentCard | null>(null);
  const [editing, setEditing] = useState<PaymentCard | null | 'new'>(null);
  const [deleting, setDeleting] = useState<PaymentCard | null>(null);
  const [bankEditing, setBankEditing] = useState<{ account: PaymentCard | null; suggestion?: BankAccountSuggestion | null } | null>(null);
  const [suggestions, setSuggestions] = useState<BankAccountSuggestion[]>([]);

  const load = useCallback(() => {
    api.listPaymentCards().then(setCards).catch((e) => setError(String(e)));
    api.listBankAccountSuggestions().then(setSuggestions).catch(() => setSuggestions([]));
  }, []);

  // Cards and bank accounts share one table; each opens its own editor.
  const edit = (c: PaymentCard | 'new') => (c !== 'new' && c.cardType === 'bank' ? setBankEditing({ account: c }) : setEditing(c));

  useEffect(() => {
    load();
  }, [load]);

  // Deep-link from global search (worker's runSearch routes a
  // payment_card match to /wallet?tab=database&type=payment with openId
  // set).
  useEffect(() => {
    const openId = (location.state as { openId?: string } | null)?.openId;
    if (!openId || !cards) return;
    const match = cards.find((c) => c.id === openId);
    if (match) setOpenCard(match);
    navigate('.', { replace: true, state: null });
  }, [location.state, cards, navigate]);

  async function handleDeleteConfirmed() {
    if (!deleting) return;
    await api.deletePaymentCard(deleting.id);
    setCards((prev) => (prev ? prev.filter((c) => c.id !== deleting.id) : prev));
    setDeleting(null);
  }

  function handleSaved(card: PaymentCard) {
    setCards((prev) => {
      if (!prev) return prev;
      const exists = prev.some((c) => c.id === card.id);
      return exists ? prev.map((c) => (c.id === card.id ? card : c)) : [...prev, card];
    });
    setOpenCard((prev) => (prev && prev.id === card.id ? card : prev));
    if (card.cardType === 'bank') setSuggestions((prev) => prev.filter((x) => x.last4 !== card.last4));
  }

  const payCards = cards?.filter((c) => c.cardType !== 'bank') ?? [];
  const banks = cards?.filter((c) => c.cardType === 'bank') ?? [];

  if (error) return <div className="empty-state">Couldn't load Payment Cards: {error}</div>;
  if (!cards) return <div className="empty-state">Loading…</div>;

  return (
    <div>
      <div className="wallet-page__toolbar">
        <div className="wallet-editor__hint" style={{ flex: 1 }}>
          Credit and debit cards and bank accounts, stored securely. Flag a card "earns rewards" to link it to the Rewards tab.
        </div>
        <button type="button" className="btn btn--ghost" onClick={() => setBankEditing({ account: null })}>
          + Add Bank Account
        </button>
        <button type="button" className="btn" onClick={() => setEditing('new')}>
          + Add Card
        </button>
      </div>

      <div className="wallet-page__section">
        <div className="wallet-page__section-title">Cards</div>
        {payCards.length === 0 ? (
          <div className="empty-state">No payment cards yet — add your first one.</div>
        ) : (
          <div className="wallet-tile-grid">
            {payCards.map((c) => (
              <PaymentCardTile key={c.id} card={c} onOpen={setOpenCard} onEdit={edit} onDelete={setDeleting} />
            ))}
          </div>
        )}
      </div>

      <div className="wallet-page__section">
        <div className="wallet-page__section-title">Bank Accounts</div>
        {suggestions.length > 0 && (
          <div className="bank-suggest">
            {suggestions.map((sg) => (
              <div key={sg.last4} className="bank-suggest__row">
                <span>
                  Found on your {sg.folderNickname} statements: <strong>{BANK_KIND_LABEL[sg.kind === 'checking' || sg.kind === 'savings' ? sg.kind : 'other']} ••{sg.last4}</strong>
                </span>
                <button type="button" className="btn btn--sm" onClick={() => setBankEditing({ account: null, suggestion: sg })}>
                  Add to Wallet
                </button>
              </div>
            ))}
          </div>
        )}
        {banks.length === 0 ? (
          suggestions.length === 0 && <div className="empty-state">No bank accounts yet — add checking and savings to keep account and routing numbers handy and pick them as a payer.</div>
        ) : (
          <div className="wallet-tile-grid">
            {banks.map((c) => (
              <PaymentCardTile key={c.id} card={c} onOpen={setOpenCard} onEdit={edit} onDelete={setDeleting} />
            ))}
          </div>
        )}
      </div>

      {openCard && (
        <PaymentCardDetail
          card={openCard}
          onClose={() => setOpenCard(null)}
          onEdit={() => {
            edit(openCard);
            setOpenCard(null);
          }}
        />
      )}

      {bankEditing && <BankAccountEditor account={bankEditing.account} suggestion={bankEditing.suggestion} onClose={() => setBankEditing(null)} onSaved={handleSaved} />}

      {editing !== null && <PaymentCardEditor card={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={handleSaved} />}

      {deleting && (
        <ConfirmModal
          title={deleting.cardType === 'bank' ? 'Delete bank account?' : 'Delete card?'}
          body={
            deleting.cardType === 'bank'
              ? `"${deleting.nickname}" will be removed from Wallet for good. Anything it pays keeps it as text and gets flagged. (If the account just closed, edit it and mark it closed instead.)`
              : `"${deleting.nickname}" will be removed from Payment Cards for good. Its linked Rewards card (if any) is kept — delete that separately from the Rewards tab.`
          }
          onConfirm={handleDeleteConfirmed}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

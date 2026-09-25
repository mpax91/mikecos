import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { PaymentCard } from '../api/types';
import { PaymentCardTile } from './PaymentCardTile';
import { PaymentCardDetail } from './PaymentCardDetail';
import { PaymentCardEditor } from './PaymentCardEditor';
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

  const load = useCallback(() => {
    api.listPaymentCards().then(setCards).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Deep-link from global search (worker's runSearch routes a
  // payment_card match to /wallet?tab=payment with openId set).
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
  }

  if (error) return <div className="empty-state">Couldn't load Payment Cards: {error}</div>;
  if (!cards) return <div className="empty-state">Loading…</div>;

  return (
    <div>
      <div className="wallet-page__toolbar">
        <div className="wallet-editor__hint" style={{ flex: 1 }}>
          Credit and debit cards, stored securely. Flag a card "earns rewards" to link it to the Rewards tab.
        </div>
        <button type="button" className="btn" onClick={() => setEditing('new')}>
          + Add Card
        </button>
      </div>

      {cards.length === 0 ? (
        <div className="empty-state">No payment cards yet — add your first one.</div>
      ) : (
        <div className="wallet-page__section">
          <div className="wallet-tile-grid">
            {cards.map((c) => (
              <PaymentCardTile key={c.id} card={c} onOpen={setOpenCard} onEdit={setEditing} onDelete={setDeleting} />
            ))}
          </div>
        </div>
      )}

      {openCard && (
        <PaymentCardDetail
          card={openCard}
          onClose={() => setOpenCard(null)}
          onEdit={() => {
            setEditing(openCard);
            setOpenCard(null);
          }}
        />
      )}

      {editing !== null && <PaymentCardEditor card={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={handleSaved} />}

      {deleting && (
        <ConfirmModal
          title="Delete card?"
          body={`"${deleting.nickname}" will be removed from Payment Cards for good. Its linked Rewards card (if any) is kept — delete that separately from the Rewards tab.`}
          onConfirm={handleDeleteConfirmed}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

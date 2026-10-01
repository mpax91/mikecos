import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { WalletCard } from '../api/types';
import { WalletCardTile } from './WalletCardTile';
import { WalletBarcodeView } from './WalletBarcodeView';
import { WalletCardEditor } from './WalletCardEditor';
import { ConfirmModal } from './ConfirmModal';

/** Wallet Phase 1 — loyalty/membership/pass/gift cards, built for one
 * moment specifically: standing at a register with a line behind you,
 * needing the right card on screen in a couple of taps. Everything here is
 * organized around that — a Favorites row pinned to the top and category
 * chips to narrow a long list — with editing pushed behind a kebab menu so
 * it never gets in the way of just finding a card. Search itself lives one
 * level up, in CardDatabasePanel, since it now searches across Loyalty,
 * Payment, and Rewards together rather than just this tab.
 *
 * Split out of WalletPage (which now also hosts the Rewards tab) — this
 * component owns everything about the "My Cards" tab specifically. */
export function WalletMyCardsPanel() {
  const location = useLocation();
  const navigate = useNavigate();

  const [cards, setCards] = useState<WalletCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [openCard, setOpenCard] = useState<WalletCard | null>(null);
  const [editing, setEditing] = useState<WalletCard | null | 'new'>(null);
  const [deleting, setDeleting] = useState<WalletCard | null>(null);

  const load = useCallback(() => {
    api.listWalletCards().then(setCards).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Deep-link from global search (see worker's runSearch — a wallet_card
  // match sets openId and routes here) — same router-state pattern as
  // Vault notes/Jots, since a card has no route of its own to land on.
  useEffect(() => {
    const openId = (location.state as { openId?: string } | null)?.openId;
    if (!openId || !cards) return;
    const match = cards.find((c) => c.id === openId);
    if (match) setOpenCard(match);
    navigate('.', { replace: true, state: null });
  }, [location.state, cards, navigate]);

  const categories = useMemo(() => {
    if (!cards) return [];
    const seen = new Map<string, number>();
    for (const c of cards) seen.set(c.category, (seen.get(c.category) ?? 0) + 1);
    return Array.from(seen.keys()).sort((a, b) => (seen.get(b)! - seen.get(a)!) || a.localeCompare(b));
  }, [cards]);

  const filtered = useMemo(() => {
    if (!cards) return [];
    return cards.filter((c) => !activeCategory || c.category === activeCategory);
  }, [cards, activeCategory]);

  const favorites = filtered.filter((c) => c.pinned);
  const rest = filtered.filter((c) => !c.pinned);

  async function togglePinned(card: WalletCard) {
    const updated = await api.updateWalletCard(card.id, { pinned: !card.pinned });
    setCards((prev) => (prev ? prev.map((c) => (c.id === updated.id ? updated : c)) : prev));
  }

  async function handleDeleteConfirmed() {
    if (!deleting) return;
    await api.deleteWalletCard(deleting.id);
    setCards((prev) => (prev ? prev.filter((c) => c.id !== deleting.id) : prev));
    setDeleting(null);
  }

  // Doesn't close the editor — a brand-new card's first save just unlocks
  // its Details section in place (see WalletCardEditor's own comment), so
  // closing here would immediately hide what the save just unlocked.
  function handleSaved(card: WalletCard) {
    setCards((prev) => {
      if (!prev) return prev;
      const exists = prev.some((c) => c.id === card.id);
      return exists ? prev.map((c) => (c.id === card.id ? card : c)) : [...prev, card];
    });
    setEditing((prev) => (prev && prev !== 'new' && prev.id === card.id ? card : prev === 'new' ? card : prev));
  }

  if (error) return <div className="empty-state">Couldn't load Wallet: {error}</div>;
  if (!cards) return <div className="empty-state">Loading…</div>;

  return (
    <div>
      <div className="wallet-page__toolbar">
        <div className="wallet-editor__hint" style={{ flex: 1 }}>
          Loyalty, membership, and gift cards. Use the search box above to find a card across your whole wallet.
        </div>
        <button type="button" className="btn" onClick={() => setEditing('new')}>
          + Add Card
        </button>
      </div>

      {categories.length > 1 && (
        <div className="wallet-page__chips">
          <button type="button" className={`wallet-page__chip${activeCategory === null ? ' is-active' : ''}`} onClick={() => setActiveCategory(null)}>
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              className={`wallet-page__chip${activeCategory === cat ? ' is-active' : ''}`}
              onClick={() => setActiveCategory(activeCategory === cat ? null : cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      )}

      {cards.length === 0 ? (
        <div className="empty-state">No cards yet — add your first one.</div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">Nothing matches.</div>
      ) : (
        <>
          {favorites.length > 0 && (
            <div className="wallet-page__section">
              <div className="wallet-page__section-title">Favorites</div>
              <div className="wallet-tile-grid">
                {favorites.map((c) => (
                  <WalletCardTile
                    key={c.id}
                    card={c}
                    onOpen={setOpenCard}
                    onEdit={setEditing}
                    onTogglePinned={togglePinned}
                    onDelete={setDeleting}
                  />
                ))}
              </div>
            </div>
          )}
          {rest.length > 0 && (
            <div className="wallet-page__section">
              {favorites.length > 0 && <div className="wallet-page__section-title">All Cards</div>}
              <div className="wallet-tile-grid">
                {rest.map((c) => (
                  <WalletCardTile
                    key={c.id}
                    card={c}
                    onOpen={setOpenCard}
                    onEdit={setEditing}
                    onTogglePinned={togglePinned}
                    onDelete={setDeleting}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {openCard && (
        <WalletBarcodeView
          card={openCard}
          onClose={() => setOpenCard(null)}
          onEdit={() => {
            setEditing(openCard);
            setOpenCard(null);
          }}
        />
      )}

      {editing !== null && <WalletCardEditor card={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={handleSaved} />}

      {deleting && (
        <ConfirmModal
          title="Delete card?"
          body={`"${deleting.name}" will be removed from Wallet for good.`}
          onConfirm={handleDeleteConfirmed}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

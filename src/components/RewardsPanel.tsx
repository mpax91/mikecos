import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { RewardsCard } from '../api/types';
import { RewardsCardTile } from './RewardsCardTile';
import { RewardsCardDetail } from './RewardsCardDetail';
import { RewardsCardEditor } from './RewardsCardEditor';
import { ConfirmModal } from './ConfirmModal';
import { cardsForThisQuarter, findBestCardsFor } from '../utils/rewards';

const QUICK_CHIPS = ['Dining', 'Gas', 'Groceries', 'Travel', 'Drugstores', 'Streaming'];

type RewardsSubTab = 'quarter' | 'find' | 'cards';

/** Wallet Phase 2 — the credit-card rewards optimizer. Three sub-views,
 * each answering a different real question rather than one generic list:
 * "what should I be carrying" (This Quarter), "what should I pay with
 * right now" (Find — the one thing the team's earlier Card Caddy build
 * didn't do well, per Mike's own critique: it didn't surface a card's
 * non-cashback perks alongside the recommendation, so this view always
 * does), and "manage the ~15 cards themselves" (Cards). Quarterly spend
 * caps are deliberately never tracked — an explicit simplification Mike
 * asked for. */
export function RewardsPanel() {
  const location = useLocation();
  const navigate = useNavigate();

  const [cards, setCards] = useState<RewardsCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sub, setSub] = useState<RewardsSubTab>('quarter');
  const [openCard, setOpenCard] = useState<RewardsCard | null>(null);
  const [editing, setEditing] = useState<RewardsCard | null | 'new'>(null);
  const [deleting, setDeleting] = useState<RewardsCard | null>(null);
  const [findQuery, setFindQuery] = useState('');

  const load = useCallback(() => {
    api.listRewardsCards().then(setCards).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Deep-link from global search (worker's runSearch routes a rewards_card
  // match to /wallet?tab=rewards with openId set) — same router-state
  // pattern Wallet's own cards use.
  useEffect(() => {
    const openId = (location.state as { openId?: string } | null)?.openId;
    if (!openId || !cards) return;
    const match = cards.find((c) => c.id === openId);
    if (match) {
      setOpenCard(match);
      setSub('cards');
    }
    navigate('.', { replace: true, state: null });
  }, [location.state, cards, navigate]);

  async function toggleAlwaysCarry(card: RewardsCard) {
    const updated = await api.updateRewardsCard(card.id, { alwaysCarry: !card.alwaysCarry });
    setCards((prev) => (prev ? prev.map((c) => (c.id === updated.id ? updated : c)) : prev));
  }

  async function handleDeleteConfirmed() {
    if (!deleting) return;
    await api.deleteRewardsCard(deleting.id);
    setCards((prev) => (prev ? prev.filter((c) => c.id !== deleting.id) : prev));
    setDeleting(null);
  }

  function handleSaved(card: RewardsCard) {
    setCards((prev) => {
      if (!prev) return prev;
      const exists = prev.some((c) => c.id === card.id);
      return exists ? prev.map((c) => (c.id === card.id ? card : c)) : [...prev, card];
    });
    setOpenCard((prev) => (prev && prev.id === card.id ? card : prev));
  }

  const activeCards = useMemo(() => (cards ?? []).filter((c) => c.active), [cards]);
  const thisQuarter = useMemo(() => cardsForThisQuarter(activeCards), [activeCards]);
  const findResults = useMemo(() => findBestCardsFor(activeCards, findQuery), [activeCards, findQuery]);

  if (error) return <div className="empty-state">Couldn't load Rewards: {error}</div>;
  if (!cards) return <div className="empty-state">Loading…</div>;

  return (
    <div>
      <div className="wallet-page__toolbar">
        <div className="rewards-panel__subtabs">
          <button type="button" className={`rewards-panel__subtab${sub === 'quarter' ? ' is-active' : ''}`} onClick={() => setSub('quarter')}>
            This Quarter
          </button>
          <button type="button" className={`rewards-panel__subtab${sub === 'find' ? ' is-active' : ''}`} onClick={() => setSub('find')}>
            Find
          </button>
          <button type="button" className={`rewards-panel__subtab${sub === 'cards' ? ' is-active' : ''}`} onClick={() => setSub('cards')}>
            All Cards
          </button>
        </div>
        <button type="button" className="btn" onClick={() => setEditing('new')}>
          + Add Card
        </button>
      </div>

      {cards.length === 0 && (
        <div className="empty-state">No cards yet — add the first one to start building out your quarterly picture.</div>
      )}

      {cards.length > 0 && sub === 'quarter' && (
        <div className="wallet-page__section">
          <div className="wallet-page__section-title">Carry these this quarter</div>
          {thisQuarter.length === 0 ? (
            <div className="empty-state">
              Nothing flagged — mark a card "Always Carry," or add a rotating bonus with dates covering today, on the All Cards tab.
            </div>
          ) : (
            <div className="wallet-tile-grid">
              {thisQuarter.map((c) => (
                <RewardsCardTile key={c.id} card={c} onOpen={setOpenCard} onEdit={setEditing} onToggleAlwaysCarry={toggleAlwaysCarry} onDelete={setDeleting} />
              ))}
            </div>
          )}
        </div>
      )}

      {cards.length > 0 && sub === 'find' && (
        <div className="wallet-page__section">
          <input
            type="search"
            className="wallet-page__search"
            placeholder="What are you buying? (e.g. groceries, hotel, gas)"
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
          />
          <div className="wallet-page__chips">
            {QUICK_CHIPS.map((chip) => (
              <button key={chip} type="button" className={`wallet-page__chip${findQuery === chip ? ' is-active' : ''}`} onClick={() => setFindQuery(chip)}>
                {chip}
              </button>
            ))}
          </div>

          {!findQuery.trim() ? (
            <div className="empty-state">Type what you're buying, or tap a category above.</div>
          ) : (
            <ul className="rewards-find__results">
              {findResults.map(({ card, bonus, rate }) => (
                <li key={card.id} className="rewards-find__result" onClick={() => setOpenCard(card)}>
                  <div className="rewards-find__result-rate">{rate}%</div>
                  <div className="rewards-find__result-body">
                    <div className="rewards-find__result-name">{card.nickname}</div>
                    <div className="rewards-find__result-reason">
                      {bonus ? (
                        <>
                          {bonus.category}
                          {bonus.kind === 'rotating' && ' · active now'}
                        </>
                      ) : (
                        'base rate — no matching bonus category'
                      )}
                    </div>
                    {card.perks.length > 0 && (
                      <div className="rewards-find__result-perks">{card.perks.map((p) => p.label).join(' · ')}</div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {cards.length > 0 && sub === 'cards' && (
        <div className="wallet-page__section">
          <div className="wallet-tile-grid">
            {cards.map((c) => (
              <RewardsCardTile key={c.id} card={c} onOpen={setOpenCard} onEdit={setEditing} onToggleAlwaysCarry={toggleAlwaysCarry} onDelete={setDeleting} />
            ))}
          </div>
        </div>
      )}

      {openCard && (
        <RewardsCardDetail
          card={openCard}
          onClose={() => setOpenCard(null)}
          onEdit={() => {
            setEditing(openCard);
            setOpenCard(null);
          }}
        />
      )}

      {editing !== null && <RewardsCardEditor card={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={handleSaved} />}

      {deleting && (
        <ConfirmModal
          title="Delete card?"
          body={`"${deleting.nickname}" and its bonus categories and perks will be removed for good.`}
          onConfirm={handleDeleteConfirmed}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

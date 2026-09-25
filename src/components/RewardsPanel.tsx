import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { RewardsCard } from '../api/types';
import { RewardsCardTile } from './RewardsCardTile';
import { RewardsCardDetail } from './RewardsCardDetail';
import { RewardsCardEditor } from './RewardsCardEditor';
import { RewardsImportModal } from './RewardsImportModal';
import { ConfirmModal } from './ConfirmModal';
import {
  carryPlan,
  cardsNeedingQuarterUpdate,
  everydayCategories,
  bestCardForCategory,
  defaultFlatRateCard,
  findBestCardsFor,
  onlineEligibleCards,
  describeRotatingWindow,
  type RewardsMatch,
} from '../utils/rewards';

const QUICK_CHIPS = ['Dining', 'Gas', 'Groceries', 'Travel', 'Drugstores', 'Streaming'];

type RewardsSubTab = 'best' | 'find' | 'cards';

/** Wallet Phase 2 — the credit-card rewards optimizer. Three sub-views,
 * each answering a different real question rather than one generic list:
 * "what should I be carrying, and what's the best card for my everyday
 * spending" (Best Cards — deliberately not restricted to cards with a
 * rotating category; the flat-rate default and fixed-category cards
 * belong here too, per Mike's own correction that "This Quarter" was too
 * narrow a frame), "what should I pay with right now for a specific
 * purchase or merchant" (Find — the one thing the team's earlier Card
 * Caddy build didn't do well, per Mike's own critique: it didn't surface
 * a card's non-cashback perks alongside the recommendation, so this view
 * always does), and "manage the ~15 cards themselves" (Cards). Quarterly
 * spend caps are deliberately never tracked — an explicit simplification
 * Mike asked for. */
export function RewardsPanel() {
  const location = useLocation();
  const navigate = useNavigate();

  const [cards, setCards] = useState<RewardsCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sub, setSub] = useState<RewardsSubTab>('best');
  const [openCard, setOpenCard] = useState<RewardsCard | null>(null);
  const [editing, setEditing] = useState<RewardsCard | null | 'new'>(null);
  const [deleting, setDeleting] = useState<RewardsCard | null>(null);
  const [importing, setImporting] = useState(false);
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
  const carry = useMemo(() => carryPlan(activeCards), [activeCards]);
  const needsUpdate = useMemo(() => cardsNeedingQuarterUpdate(activeCards), [activeCards]);
  // Only worth a row here when it actually beats the default flat-rate
  // card's own rate — the default already covers every category at that
  // floor (2% on Wells Fargo Active Cash, say), so a category where
  // nothing beats it isn't an answer worth surfacing, it's just noise.
  const floorRate = useMemo(() => defaultFlatRateCard(activeCards)?.baseRate ?? 0, [activeCards]);
  const categoryBests = useMemo(
    () =>
      everydayCategories(activeCards)
        .map((category) => ({ category, match: bestCardForCategory(activeCards, category) }))
        .filter((row): row is { category: string; match: RewardsMatch } => !!row.match && row.match.rate > floorRate),
    [activeCards, floorRate]
  );
  // Below-floor cards are hidden here too — same reasoning as the category
  // table: a 1% card is never the right answer when the default already
  // covers everything at 2%, so it's just noise in a ranked list.
  const findResults = useMemo(
    () => findBestCardsFor(activeCards, findQuery).filter((m) => m.rate >= floorRate),
    [activeCards, findQuery, floorRate]
  );
  // Find deliberately doesn't try to know whether "Rhoback.com" is an
  // online store — Mike doesn't want a maintained merchant database. So
  // instead, whenever there's a query, it also surfaces any card whose
  // best trick is an online-only bonus (Amazon.com, "Online Shopping,"
  // Chase Travel) as a standing "if this is online" suggestion, regardless
  // of whether the query text matched it directly.
  const onlineCards = useMemo(() => onlineEligibleCards(activeCards), [activeCards]);

  if (error) return <div className="empty-state">Couldn't load Rewards: {error}</div>;
  if (!cards) return <div className="empty-state">Loading…</div>;

  return (
    <div>
      <div className="wallet-page__toolbar">
        <div className="rewards-panel__subtabs">
          <button type="button" className={`rewards-panel__subtab${sub === 'best' ? ' is-active' : ''}`} onClick={() => setSub('best')}>
            Best Cards
          </button>
          <button type="button" className={`rewards-panel__subtab${sub === 'find' ? ' is-active' : ''}`} onClick={() => setSub('find')}>
            Find
          </button>
          <button type="button" className={`rewards-panel__subtab${sub === 'cards' ? ' is-active' : ''}`} onClick={() => setSub('cards')}>
            All Cards
          </button>
        </div>
        <div className="rewards-panel__toolbar-actions">
          <button type="button" className="btn btn--ghost" onClick={() => setImporting(true)}>
            Import…
          </button>
          <button type="button" className="btn" onClick={() => setEditing('new')}>
            + Add Card
          </button>
        </div>
      </div>

      {cards.length === 0 && (
        <div className="empty-state">No cards yet — add the first one to start building out your best-card picture.</div>
      )}

      {cards.length > 0 && sub === 'best' && (
        <>
          {needsUpdate.length > 0 && (
            <div className="rewards-panel__notice">
              <span>
                Rotating {needsUpdate.length === 1 ? 'category has' : 'categories have'} ended with nothing queued up for{' '}
                <strong>{needsUpdate.map((c) => c.nickname).join(', ')}</strong> — set this quarter's bonus on the All Cards tab.
              </span>
              <button type="button" className="rewards-panel__notice-link" onClick={() => setSub('cards')}>
                Update now
              </button>
            </div>
          )}

          <div className="wallet-page__section">
            <div className="wallet-page__section-title">Carry in your wallet</div>
            {carry.length === 0 ? (
              <div className="empty-state">Add a card to get a carry recommendation.</div>
            ) : (
              <div className="wallet-tile-grid">
                {carry.map(({ card: c, reasons }) => (
                  <RewardsCardTile
                    key={c.id}
                    card={c}
                    reason={reasons.join(' · ')}
                    onOpen={setOpenCard}
                    onEdit={setEditing}
                    onToggleAlwaysCarry={toggleAlwaysCarry}
                    onDelete={setDeleting}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="wallet-page__section">
            <div className="wallet-page__section-title">Worth switching for</div>
            {categoryBests.length === 0 ? (
              <div className="empty-state">
                {floorRate > 0
                  ? `Nothing beats your ${floorRate}% default right now — every category's covered by whatever's in your wallet already.`
                  : "Add a card's base rate to see category recommendations."}
              </div>
            ) : (
              <ul className="rewards-find__results">
                {categoryBests.map(({ category, match }) => (
                  <RewardsMatchRow
                    key={category}
                    label={category}
                    rate={match.rate}
                    card={match.card}
                    onOpen={setOpenCard}
                    subtitle={
                      <>
                        {match.card.nickname}
                        {match.bonus?.kind === 'rotating'
                          ? ` · ${describeRotatingWindow(match.bonus.startsOn, match.bonus.endsOn) ?? 'rotating'}`
                          : !match.bonus
                          ? ' · base rate'
                          : ''}
                      </>
                    }
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {cards.length > 0 && sub === 'find' && (
        <div className="wallet-page__section">
          <input
            type="search"
            className="wallet-page__search"
            placeholder="What are you buying, or from where? (e.g. groceries, Home Depot, Rhoback.com)"
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
            <div className="empty-state">Type what you're buying (or a merchant name), or tap a category above.</div>
          ) : (
            <>
              <ul className="rewards-find__results">
                {findResults.map((match) => (
                  <RewardsMatchRow
                    key={match.card.id}
                    label={match.card.nickname}
                    rate={match.rate}
                    card={match.card}
                    onOpen={setOpenCard}
                    perks={match.card.perks.map((p) => p.label)}
                    subtitle={
                      match.bonus ? (
                        <>
                          {match.bonus.category}
                          {match.bonus.kind === 'rotating' && ' · active now'}
                        </>
                      ) : (
                        'no matching category — base rate'
                      )
                    }
                  />
                ))}
              </ul>

              {onlineCards.length > 0 && (
                <div className="rewards-find__online">
                  <div className="rewards-find__online-title">If this is an online purchase</div>
                  <ul className="rewards-find__results">
                    {onlineCards.map((match) => (
                      <RewardsMatchRow
                        key={match.card.id}
                        label={match.card.nickname}
                        rate={match.rate}
                        card={match.card}
                        onOpen={setOpenCard}
                        subtitle={match.bonus?.category ?? 'online'}
                      />
                    ))}
                  </ul>
                </div>
              )}
            </>
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

      {importing && <RewardsImportModal onClose={() => setImporting(false)} onImported={load} />}

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

/** One "best card" answer row — shared by the category reference table
 * (label = category, subtitle = which card and why) and the Find results
 * (label = card, subtitle = which category/merchant matched) — same
 * rate-first visual language either way, just which text goes where. */
function RewardsMatchRow({
  label,
  subtitle,
  rate,
  card,
  perks,
  onOpen,
}: {
  label: string;
  subtitle: React.ReactNode;
  rate: number;
  card: RewardsCard;
  perks?: string[];
  onOpen: (card: RewardsCard) => void;
}) {
  return (
    <li className="rewards-find__result" onClick={() => onOpen(card)}>
      <div className="rewards-find__result-rate">{rate}%</div>
      <div className="rewards-find__result-body">
        <div className="rewards-find__result-name">{label}</div>
        <div className="rewards-find__result-reason">{subtitle}</div>
        {perks && perks.length > 0 && <div className="rewards-find__result-perks">{perks.join(' · ')}</div>}
      </div>
    </li>
  );
}

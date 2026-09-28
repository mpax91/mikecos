import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { RewardsCard, RewardsMerchant } from '../api/types';
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
  topFindResults,
  upcomingBonusesFor,
  findRelevantPerks,
  findMatchingOffers,
  resolveMerchant,
  onlineEligibleCards,
  describeRotatingWindow,
  headlineRatesForCards,
  type RewardsMatch,
} from '../utils/rewards';

const QUICK_CHIPS = ['Dining', 'Gas', 'Groceries', 'Travel', 'Drugstores', 'Streaming'];

/** "2026-10-01" -> "Oct 1". Parsed as a local date on purpose — new
 * Date("2026-10-01") is UTC midnight, which renders as Sept 30 in New York. */
function formatStartDate(ymd: string | null | undefined): string {
  if (!ymd) return 'soon';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** 'home' — Wallet's default landing view: "Best Cards" (carry plan) along
 * the top, then every reward card sorted by its own best current rate
 * (headlineRatesForCards), an embedded Find search, and the category
 * reference table — all in one screen, no sub-tab clicking required. This
 * is what Mike's redesign asked for explicitly: no more guessing which of
 * three tabs (My Cards/Rewards/Payment Cards) to be in.
 * 'manage' — the full card list (add/edit/delete/import/always-carry),
 * shown from Card Database's "Rewards" pill instead. Quarterly spend caps
 * are deliberately never tracked — an explicit simplification Mike asked
 * for, unrelated to this split. */
export function RewardsPanel({ mode = 'home' }: { mode?: 'home' | 'manage' }) {
  const location = useLocation();
  const navigate = useNavigate();

  const [cards, setCards] = useState<RewardsCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openCard, setOpenCard] = useState<RewardsCard | null>(null);
  const [editing, setEditing] = useState<RewardsCard | null | 'new'>(null);
  const [deleting, setDeleting] = useState<RewardsCard | null>(null);
  const [importing, setImporting] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [merchants, setMerchants] = useState<RewardsMerchant[]>([]);
  const [teachOpen, setTeachOpen] = useState(false);
  const [teachCategory, setTeachCategory] = useState('');
  const [teachSaving, setTeachSaving] = useState(false);
  const [teachError, setTeachError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.listRewardsCards().then(setCards).catch((e) => setError(String(e)));
    api.listRewardsMerchants().then(setMerchants).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Deep-link from global search (worker's runSearch routes a rewards_card
  // match to /wallet?tab=database&type=rewards with openId set) — same
  // router-state pattern Wallet's own cards use.
  useEffect(() => {
    const openId = (location.state as { openId?: string } | null)?.openId;
    if (!openId || !cards) return;
    const match = cards.find((c) => c.id === openId);
    if (match) setOpenCard(match);
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
  // One row per card, sorted by that card's own best current rate — Mike's
  // explicit spec: "a list of all reward cards that I have - sorted by
  // highest percentage to lowest (and only showing Wells Fargo Active Cash)
  // for 2%" — i.e. never one row per bonus.
  const headlineRates = useMemo(() => headlineRatesForCards(activeCards), [activeCards]);
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
  // Perks (rental car insurance, phone protection...) and manually-noted
  // bank-portal offers (Chase/Amex/Discover) relevant to this query — see
  // findRelevantPerks/findMatchingOffers in utils/rewards.ts. Neither
  // depends on any bonus matching at all, since a perk or a targeted deal
  // can be the actual answer even when no card earns extra cashback here.
  const relevantPerks = useMemo(() => findRelevantPerks(activeCards, findQuery, merchants), [activeCards, findQuery, merchants]);
  const matchingOffers = useMemo(() => findMatchingOffers(activeCards, findQuery), [activeCards, findQuery]);
  // Only the best rate shows — anything lower is never the right answer,
  // so it's noise. Ties at the top all show (with the card that also has
  // a relevant perk first), and when nothing beats the default flat rate
  // the result is simply every card tied at that floor.
  const findResults = useMemo(
    () => topFindResults(findBestCardsFor(activeCards, findQuery, { merchants }), new Set(relevantPerks.map((p) => p.card.id))),
    [activeCards, findQuery, merchants, relevantPerks]
  );
  const topFindRate = findResults[0]?.rate ?? floorRate;
  // A rotating bonus that starts within two weeks and would beat today's
  // answer — "Discover 5% · starts Oct 1" in the last days of a quarter.
  const upcomingResults = useMemo(
    () => upcomingBonusesFor(activeCards, findQuery, topFindRate, { merchants }),
    [activeCards, findQuery, topFindRate, merchants]
  );
  // The perk callout only lists perks on cards that are actually part of
  // the answer, or perks worth knowing about when no card earns a bonus
  // here at all (rental car coverage for "hertz") — a phone-protection
  // perk on a 2% card isn't a reason to pick it over a 3% card that has
  // the same protection.
  const shownPerks = useMemo(() => {
    const shownIds = new Set(findResults.map((m) => m.card.id));
    const anyBonus = findResults.some((m) => m.bonus !== null);
    return anyBonus ? relevantPerks.filter((p) => shownIds.has(p.card.id)) : relevantPerks;
  }, [findResults, relevantPerks]);
  // Whenever the raw query itself doesn't hit a category/keyword directly,
  // the merchant directory (0058) resolves "Rhoback" -> "Online Shopping",
  // "Fios"/"T-Mobile" -> "Phone/Wireless", etc. — shown as a small
  // "recognized as ..." line so Mike knows why results are what they are,
  // and it's also what a completely unrecognized query (no resolution, no
  // direct match at all) uses to decide whether to offer the quick "teach
  // MikeOS this merchant" add below.
  const resolvedMerchant = useMemo(() => {
    const raw = findQuery.trim().toLowerCase();
    if (!raw) return null;
    const norm = raw.replace(/[^a-z0-9]+/g, '');
    return resolveMerchant(merchants, norm);
  }, [findQuery, merchants]);
  // Find deliberately doesn't try to know every e-commerce site on its
  // own — instead, whenever there's a query, it also surfaces any card
  // whose best trick is an online-only bonus (Amazon.com, "Online
  // Shopping," Chase Travel) as a standing "if this is online" suggestion,
  // regardless of whether the query text (or a merchant-directory
  // resolution) matched it directly.
  // Only when the query itself didn't land on a specific bonus — once it
  // has (Con Edison -> Discover utilities), a generic "if it's online, use
  // your Amazon card" suggestion is just noise. And only cards that beat
  // the answer above.
  const onlineCards = useMemo(() => {
    if (findResults.some((m) => m.bonus !== null)) return [];
    return onlineEligibleCards(activeCards).filter((m) => m.rate > topFindRate);
  }, [activeCards, findResults, topFindRate]);
  // Nothing at all recognized this query — no bonus/keyword hit strong
  // enough to beat the floor, no merchant-directory resolution, no perk,
  // no offer. That's the moment to offer teaching MikeOS what it is,
  // right where the gap was just felt, rather than routing Mike to a
  // separate settings screen to add it.
  const nothingRecognized = useMemo(
    () => findQuery.trim().length > 0 && findResults.every((m) => m.bonus === null) && !resolvedMerchant && relevantPerks.length === 0 && matchingOffers.length === 0,
    [findQuery, findResults, resolvedMerchant, relevantPerks, matchingOffers]
  );

  async function handleTeach() {
    const name = findQuery.trim();
    const category = teachCategory.trim();
    if (!name || !category) return;
    setTeachSaving(true);
    setTeachError(null);
    try {
      const created = await api.createRewardsMerchant({ name, aliases: null, category, notes: null });
      setMerchants((prev) => [...prev, created]);
      setTeachOpen(false);
      setTeachCategory('');
    } catch (e) {
      setTeachError(String(e));
    } finally {
      setTeachSaving(false);
    }
  }

  if (error) return <div className="empty-state">Couldn't load Rewards: {error}</div>;
  if (!cards) return <div className="empty-state">Loading…</div>;

  return (
    <div>
      {mode === 'manage' && (
        <div className="wallet-page__toolbar">
          <div className="wallet-page__section-title" style={{ margin: 0 }}>
            Rewards cards
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
      )}

      {cards.length === 0 && (
        <div className="empty-state">
          {mode === 'home'
            ? 'No reward cards yet — add one from Card Database → Rewards to start building out your best-card picture.'
            : 'No cards yet — add the first one to start building out your best-card picture.'}
        </div>
      )}

      {cards.length > 0 && needsUpdate.length > 0 && (
        <div className="rewards-panel__notice">
          <span>
            Rotating {needsUpdate.length === 1 ? 'category has' : 'categories have'} ended with nothing queued up for{' '}
            <strong>{needsUpdate.map((c) => c.nickname).join(', ')}</strong>
            {mode === 'home' ? ' — set this quarter\'s bonus in Card Database → Rewards.' : ' — set this quarter\'s bonus below.'}
          </span>
        </div>
      )}

      {cards.length > 0 && mode === 'home' && (
        <>
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
            <div className="wallet-page__section-title">All reward cards</div>
            {headlineRates.length === 0 ? (
              <div className="empty-state">Add a card to see it ranked here.</div>
            ) : (
              <ul className="rewards-find__results">
                {headlineRates.map(({ card: c, rate, bonus }) => (
                  <RewardsMatchRow
                    key={c.id}
                    label={c.nickname}
                    rate={rate}
                    card={c}
                    onOpen={setOpenCard}
                    subtitle={
                      bonus
                        ? `${bonus.category}${bonus.kind === 'rotating' ? ` · ${describeRotatingWindow(bonus.startsOn, bonus.endsOn) ?? 'rotating'}` : ''}`
                        : 'base rate'
                    }
                  />
                ))}
              </ul>
            )}
          </div>

          <div className="wallet-page__section">
            <div className="wallet-page__section-title">Find</div>
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
              {resolvedMerchant && (
                <div className="rewards-find__recognized">
                  Recognized "{findQuery.trim()}" as <strong>{resolvedMerchant.category}</strong>
                </div>
              )}

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

              {upcomingResults.length > 0 && (
                <div className="rewards-find__online">
                  <div className="rewards-find__online-title">Starting soon</div>
                  <ul className="rewards-find__results">
                    {upcomingResults.map((match) => (
                      <RewardsMatchRow
                        key={match.card.id}
                        label={match.card.nickname}
                        rate={match.rate}
                        card={match.card}
                        onOpen={setOpenCard}
                        subtitle={`${match.bonus?.category ?? 'rotating'} · starts ${formatStartDate(match.bonus?.startsOn)}`}
                      />
                    ))}
                  </ul>
                </div>
              )}

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

              {shownPerks.length > 0 && (
                <div className="rewards-find__online">
                  <div className="rewards-find__online-title">Relevant perks (not cashback)</div>
                  <ul className="rewards-find__results">
                    {shownPerks.map(({ card, perk }) => (
                      <li key={perk.id} className="rewards-find__perk-row" onClick={() => setOpenCard(card)}>
                        <div className="rewards-find__perk-icon">✓</div>
                        <div>
                          <div className="rewards-find__result-name">
                            {perk.label} <span className="rewards-find__perk-card">— {card.nickname}</span>
                          </div>
                          {perk.description && <div className="rewards-find__result-reason">{perk.description}</div>}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {matchingOffers.length > 0 && (
                <div className="rewards-find__online">
                  <div className="rewards-find__online-title">Card offers you've noted</div>
                  <ul className="rewards-find__results">
                    {matchingOffers.map(({ card, offer }) => (
                      <li key={offer.id} className="rewards-find__perk-row" onClick={() => setOpenCard(card)}>
                        <div className="rewards-find__perk-icon">🎟</div>
                        <div>
                          <div className="rewards-find__result-name">
                            {offer.merchant} <span className="rewards-find__perk-card">— {card.nickname}</span>
                          </div>
                          <div className="rewards-find__result-reason">
                            {offer.description}
                            {offer.expiresOn && ` · expires ${offer.expiresOn}`}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {nothingRecognized && (
                <div className="rewards-find__teach">
                  {!teachOpen ? (
                    <button type="button" className="btn btn--ghost" onClick={() => setTeachOpen(true)}>
                      Teach MikeOS what "{findQuery.trim()}" is
                    </button>
                  ) : (
                    <div className="rewards-find__teach-form">
                      <div className="rewards-find__teach-label">
                        "{findQuery.trim()}" is a... <span className="settings-page__section-hint" style={{ margin: 0 }}>(category name, e.g. "Online Shopping", "Phone/Wireless", "Car Rental")</span>
                      </div>
                      <div className="rewards-find__teach-row">
                        <input
                          autoFocus
                          value={teachCategory}
                          onChange={(e) => setTeachCategory(e.target.value)}
                          placeholder="Category"
                          onKeyDown={(e) => e.key === 'Enter' && handleTeach()}
                        />
                        <button type="button" className="btn" onClick={handleTeach} disabled={!teachCategory.trim() || teachSaving}>
                          {teachSaving ? 'Saving…' : 'Save'}
                        </button>
                        <button type="button" className="btn btn--ghost" onClick={() => setTeachOpen(false)}>
                          Cancel
                        </button>
                      </div>
                      {teachError && <div className="settings-page__rrule-error">{teachError}</div>}
                    </div>
                  )}
                </div>
              )}
            </>
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

      {cards.length > 0 && mode === 'manage' && (
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
          onChanged={handleSaved}
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

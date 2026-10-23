import { useMemo, useState } from 'react';
import type { Bet, BetLinkKind } from '../api/types';
import { Modal } from './Modal';
import { betTitle, formatMoney, formatOdds, LINK_KIND_LABELS, linkScenarios, summarizeLinkGroup } from '../utils/bets';

const NEARBY_DAYS = 3;

function dayDiff(a: string, b: string): number {
  return Math.abs(Math.round((Date.parse(`${a}T12:00:00`) - Date.parse(`${b}T12:00:00`)) / 86_400_000));
}

/** Ties bets together as an Arb or a Hedge (0143_bet_links.sql). Opened
 * from a bet's ⋯ menu on the Log: that bet is the anchor, the rest are its
 * neighbors within a few days (an arb's sides are almost always the same
 * game, logged the same day). Shows what each outcome pays so Mike can see
 * the locked-in profit before saving. */
export function BetLinkModal({
  anchor,
  bets,
  onClose,
  onSave,
  onUnlink,
}: {
  anchor: Bet;
  bets: Bet[];
  onClose: () => void;
  onSave: (params: { bet_ids: string[]; kind: BetLinkKind; original_id: string | null; link_id: string | null }) => Promise<void>;
  onUnlink: (linkId: string) => Promise<void>;
}) {
  const existingGroup = useMemo(() => (anchor.link_id ? bets.filter((b) => b.link_id === anchor.link_id) : []), [anchor, bets]);
  const [kind, setKind] = useState<BetLinkKind>(anchor.link_kind ?? 'arb');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(existingGroup.length ? existingGroup.map((b) => b.id) : [anchor.id]));
  const [originalId, setOriginalId] = useState<string>(() => existingGroup.find((b) => b.link_role === 'original')?.id ?? anchor.id);
  const [showAll, setShowAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = useMemo(() => {
    const others = bets.filter((b) => b.id !== anchor.id && (showAll || selected.has(b.id) || dayDiff(b.date, anchor.date) <= NEARBY_DAYS));
    others.sort((a, b) => dayDiff(a.date, anchor.date) - dayDiff(b.date, anchor.date) || (a.created_at < b.created_at ? 1 : -1));
    return [anchor, ...others];
  }, [bets, anchor, showAll, selected]);

  const chosen = candidates.filter((b) => selected.has(b.id));
  const group = chosen.length >= 2 ? summarizeLinkGroup('preview', chosen) : null;
  const scenarios = group ? linkScenarios(group.bets) : [];
  const effectiveOriginal = chosen.some((b) => b.id === originalId) ? originalId : chosen[0]?.id ?? null;

  function toggle(id: string) {
    if (id === anchor.id) return; // the bet this was opened from always stays in
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    if (chosen.length < 2) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ bet_ids: chosen.map((b) => b.id), kind, original_id: kind === 'hedge' ? effectiveOriginal : null, link_id: anchor.link_id });
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  async function unlink() {
    if (!anchor.link_id) return;
    setSaving(true);
    try {
      await onUnlink(anchor.link_id);
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  return (
    <Modal title={anchor.link_id ? `Edit ${LINK_KIND_LABELS[anchor.link_kind ?? 'arb']}` : 'Link as Arb / Hedge'} onClose={onClose} className="bet-link-modal">
      <div className="bet-link__kinds" role="radiogroup" aria-label="Kind">
        {(['arb', 'hedge'] as BetLinkKind[]).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} className={`dashboard-page__tab${kind === k ? ' is-active' : ''}`} onClick={() => setKind(k)}>
            {LINK_KIND_LABELS[k]}
          </button>
        ))}
      </div>
      <p className="bet-link__hint">
        {kind === 'arb'
          ? 'Both sides count toward your money, but not your record — an arb is a win and a loss by design.'
          : 'Your original pick still counts toward your record; the hedge bet counts toward money only.'}
      </p>

      <div className="bet-link__list">
        {candidates.map((b) => {
          const on = selected.has(b.id);
          const elsewhere = b.link_id && b.link_id !== anchor.link_id;
          return (
            <div key={b.id} className={`bet-link__row${on ? ' is-on' : ''}`}>
              <label className="bet-link__pick">
                <input type="checkbox" checked={on} disabled={b.id === anchor.id} onChange={() => toggle(b.id)} />
                <span className="bet-link__text">
                  <span className="bet-link__title">{betTitle(b)}</span>
                  <span className="bet-link__meta">
                    {b.date} · {b.sportsbook} · {formatOdds(b.odds)} · {formatMoney(b.wager)}
                    {b.stake_type === 'free_bet' && <span className="bets-log__freebet"> · Free bet</span>}
                    {elsewhere && <span className="bet-link__elsewhere"> · in another {LINK_KIND_LABELS[b.link_kind ?? 'arb']}</span>}
                  </span>
                </span>
              </label>
              {kind === 'hedge' && on && (
                <label className="bet-link__original">
                  <input type="radio" name="bet-link-original" checked={effectiveOriginal === b.id} onChange={() => setOriginalId(b.id)} />
                  Original
                </label>
              )}
            </div>
          );
        })}
      </div>
      {!showAll && (
        <button type="button" className="chip bet-link__more" onClick={() => setShowAll(true)}>
          Show bets from other dates
        </button>
      )}

      {group && (
        <div className="bet-link__preview">
          {scenarios.map((s) => (
            <div key={s.winner.id} className="bet-link__scenario">
              <span>
                If {s.winner.sportsbook} · {betTitle(s.winner)} wins
              </span>
              <span className={s.net >= 0 ? 'is-up' : 'is-down'}>{formatMoney(s.net)}</span>
            </div>
          ))}
          <div className="bet-link__verdict">
            {group.settled ? (
              <>
                <span>Actual result</span>
                <span className={group.net >= 0 ? 'is-up' : 'is-down'}>{formatMoney(group.net)}</span>
              </>
            ) : group.worst >= 0 ? (
              <>
                <span>Locked profit</span>
                <span className="is-up">{formatMoney(group.worst)}</span>
              </>
            ) : (
              <>
                <span>Worst / best case</span>
                <span>
                  <span className="is-down">{formatMoney(group.worst)}</span> / <span className={group.best >= 0 ? 'is-up' : 'is-down'}>{formatMoney(group.best)}</span>
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {error && <div className="bet-link__error">{error}</div>}

      <div className="modal__actions">
        {anchor.link_id && (
          <button className="btn btn--ghost bet-link__unlink" onClick={unlink} disabled={saving}>
            Unlink
          </button>
        )}
        <button className="btn btn--ghost" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button className="btn" onClick={save} disabled={saving || chosen.length < 2}>
          {chosen.length < 2 ? 'Pick another bet' : `Link ${chosen.length} bets`}
        </button>
      </div>
    </Modal>
  );
}

import { useState } from 'react';
import type { BetPromo, BetPromoStatus } from '../api/types';
import { COMMON_SPORTSBOOKS, SPORTS } from '../utils/bets';
import { BetsPromosTable } from './BetsPromosTable';
import { Modal } from './Modal';
import { ConfirmModal } from './ConfirmModal';
import { KebabMenu } from './KebabMenu';

// "Boost" and "Profit Boost" meant the same thing and just split the same
// promo type across two option values — collapsed into one. The rest of
// the list matches the actual promo shapes Mike logs.
const PROMO_TYPES = ['Boost', 'Insurance', 'Bonus', 'Up Early', 'Free Bet'];

const STATUS_OPTIONS: { value: BetPromoStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'used', label: 'Used' },
  { value: 'expired', label: 'Expired' },
];

/** "$10", "10", "10.50" → number; blank → null; anything else → NaN. */
function dollars(v: string): number | null {
  const t = v.trim().replace(/^\$/, '').replace(/,/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

function todayLocalISODash(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function PromoFormModal({ promo, onClose, onSave }: { promo: BetPromo | null; onClose: () => void; onSave: (params: Record<string, unknown>) => Promise<void> }) {
  const [sportsbook, setSportsbook] = useState(promo?.sportsbook ?? '');
  const [sport, setSport] = useState(promo?.sport ?? '');
  const [description, setDescription] = useState(promo?.description ?? '');
  const [promoType, setPromoType] = useState(promo?.promo_type ?? PROMO_TYPES[0]);
  // New promos default to expiring today — most bonuses do, and this is
  // the common case Mike's actually entering same-day. Editing an existing
  // promo always starts from whatever it already has (including no
  // expiration at all), never silently backfilled to today just by
  // opening the form.
  const [expiresAt, setExpiresAt] = useState(promo ? (promo.expires_at ?? '') : todayLocalISODash());
  const [legs, setLegs] = useState(promo?.legs ?? '');
  const [odds, setOdds] = useState(promo?.odds ?? '');
  const [amount, setAmount] = useState(promo?.amount ?? '');
  const [minBet, setMinBet] = useState(promo?.min_bet != null ? String(promo.min_bet) : '');
  const [maxBonus, setMaxBonus] = useState(promo?.max_bonus != null ? String(promo.max_bonus) : '');
  const [status, setStatus] = useState<BetPromoStatus>(promo?.status ?? 'active');
  const [notes, setNotes] = useState(promo?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!sportsbook.trim()) return setError('Sportsbook is required.');
    if (!description.trim() && !sport) return setError('Pick a sport or add a short description.');
    const minBetNum = dollars(minBet);
    const maxBetNum = dollars(maxBonus);
    if (Number.isNaN(minBetNum)) return setError('Min Bet should be a dollar amount, like 10.');
    if (Number.isNaN(maxBetNum)) return setError('Max Bet should be a dollar amount, like 25.');
    if (minBetNum != null && maxBetNum != null && minBetNum > maxBetNum) return setError('Min Bet is higher than Max Bet.');
    setSaving(true);
    setError(null);
    try {
      await onSave({
        sportsbook: sportsbook.trim(),
        sport: sport || null,
        description: description.trim(),
        promo_type: promoType,
        expires_at: expiresAt || null,
        legs: legs.trim() || null,
        odds: odds.trim() || null,
        amount: amount.trim() || null,
        min_bet: minBetNum,
        max_bonus: maxBetNum,
        status,
        notes: notes.trim() || undefined,
      });
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  return (
    <Modal title={promo ? 'Edit Promo' : 'Add Promo'} onClose={onClose}>
      <div className="bets-form">
        <label className="bets-form__field">
          <span>Sportsbook</span>
          <input list="bets-sportsbooks-promo" placeholder="e.g. DraftKings" value={sportsbook} onChange={(e) => setSportsbook(e.target.value)} />
          <datalist id="bets-sportsbooks-promo">
            {COMMON_SPORTSBOOKS.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </label>
        <div className="bets-form__row">
          <label className="bets-form__field">
            <span>Sport</span>
            <select value={sport} onChange={(e) => setSport(e.target.value)}>
              <option value="">Any Sport</option>
              {[...SPORTS.filter((s) => s !== 'Other'), ...(sport && !SPORTS.includes(sport) ? [sport] : [])].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="bets-form__field">
            <span>Description</span>
            <input placeholder="e.g. Parlay / SGP" value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>
        <div className="bets-form__row">
          <label className="bets-form__field">
            <span>Type</span>
            <select value={promoType} onChange={(e) => setPromoType(e.target.value)}>
              {/* Keep an older promo's custom type selectable so editing it doesn't silently change it. */}
              {[...PROMO_TYPES, ...(promoType && !PROMO_TYPES.includes(promoType) ? [promoType] : [])].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="bets-form__field">
            <span>Expires</span>
            <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </label>
        </div>
        <div className="bets-form__row">
          <label className="bets-form__field">
            <span>Min Legs</span>
            <input placeholder="e.g. 3" value={legs} onChange={(e) => setLegs(e.target.value)} />
          </label>
          <label className="bets-form__field">
            <span>Min Odds</span>
            <input placeholder="e.g. +100" value={odds} onChange={(e) => setOdds(e.target.value)} />
          </label>
        </div>
        <div className="bets-form__row">
          <label className="bets-form__field">
            <span>Value</span>
            <input placeholder="e.g. 30% or $25" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
        </div>
        <div className="bets-form__row">
          <label className="bets-form__field">
            <span>Min Bet ($)</span>
            <input placeholder="e.g. 10" inputMode="decimal" value={minBet} onChange={(e) => setMinBet(e.target.value)} />
          </label>
          <label className="bets-form__field">
            <span>Max Bet ($)</span>
            <input placeholder="e.g. 25" inputMode="decimal" value={maxBonus} onChange={(e) => setMaxBonus(e.target.value)} />
          </label>
        </div>
        <div className="bets-form__hint">Leave Min Legs, Min Odds or Min Bet blank to mean Any.</div>
        <label className="bets-form__field">
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as BetPromoStatus)}>
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="bets-form__field">
          <span>Notes (optional)</span>
          <textarea rows={2} placeholder="e.g. Must be placed before first pitch" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {error && <div className="bets-form__error">{error}</div>}
      </div>
      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button className="btn" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : promo ? 'Save' : 'Add Promo'}
        </button>
      </div>
    </Modal>
  );
}

const todayIso = todayLocalISODash();


export function BetsPromosTab({
  promos,
  onCreate,
  onUpdate,
  onDelete,
}: {
  promos: BetPromo[];
  onCreate: (params: Record<string, unknown>) => Promise<void>;
  onUpdate: (id: string, params: Record<string, unknown>) => Promise<void>;
  onDelete: (p: BetPromo) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<BetPromo | null>(null);
  const [deleting, setDeleting] = useState<BetPromo | null>(null);

  return (
    <div>
      <div className="toolbar-row">
        <p className="bets-log__meta" style={{ margin: 0 }}>
          Boosts and promos available to apply to bets — sportsbooks don't publish these anywhere Claude can pull from, so this list is only as current as what you enter.
        </p>
        <button className="btn" onClick={() => setAdding(true)}>
          + Add Promo
        </button>
      </div>

      {promos.length === 0 ? (
        <div className="empty-state">No promos logged yet.</div>
      ) : (
        <div className="bets-log card bets-promos--tab" style={{ marginTop: 12 }}>
          <BetsPromosTable
            promos={promos}
            today={todayIso}
            renderStatus={(p) => (
              <span className={`bets__result-badge ${p.status === 'active' ? 'bets__result-badge--win' : 'bets__result-badge--push'}`}>
                {STATUS_OPTIONS.find((s) => s.value === p.status)?.label}
              </span>
            )}
            renderActions={(p) => (
              <KebabMenu
                items={[
                  ...(p.status === 'active'
                    ? [{ label: 'Mark Used', onClick: () => onUpdate(p.id, { status: 'used' }) }]
                    : p.status === 'used'
                      ? [{ label: 'Mark Active', onClick: () => onUpdate(p.id, { status: 'active' }) }]
                      : []),
                  { label: 'Edit', onClick: () => setEditing(p) },
                  { label: 'Delete', onClick: () => setDeleting(p), danger: true, separatorBefore: true },
                ]}
              />
            )}
          />
        </div>
      )}

      {adding && (
        <PromoFormModal
          promo={null}
          onClose={() => setAdding(false)}
          onSave={async (params) => {
            await onCreate(params);
            setAdding(false);
          }}
        />
      )}
      {editing && (
        <PromoFormModal
          promo={editing}
          onClose={() => setEditing(null)}
          onSave={async (params) => {
            await onUpdate(editing.id, params);
            setEditing(null);
          }}
        />
      )}
      {deleting && (
        <ConfirmModal
          title="Delete promo?"
          body={`"${deleting.description}" at ${deleting.sportsbook} will be permanently deleted.`}
          onConfirm={async () => {
            await onDelete(deleting);
            setDeleting(null);
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

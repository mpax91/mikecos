import { useState } from 'react';
import type { BetPromo, BetPromoStatus } from '../api/types';
import { COMMON_SPORTSBOOKS } from '../utils/bets';
import { Modal } from './Modal';
import { ConfirmModal } from './ConfirmModal';
import { KebabMenu } from './KebabMenu';

const PROMO_TYPES = ['Boost', 'Profit Boost', 'Risk-Free', 'Bonus Bet', 'No Sweat', 'Deposit Match', 'Other'];

const STATUS_OPTIONS: { value: BetPromoStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'used', label: 'Used' },
  { value: 'expired', label: 'Expired' },
];

function todayLocalISODash(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function PromoFormModal({ promo, onClose, onSave }: { promo: BetPromo | null; onClose: () => void; onSave: (params: Record<string, unknown>) => Promise<void> }) {
  const [sportsbook, setSportsbook] = useState(promo?.sportsbook ?? '');
  const [description, setDescription] = useState(promo?.description ?? '');
  const [promoType, setPromoType] = useState(promo?.promo_type ?? PROMO_TYPES[0]);
  const [expiresAt, setExpiresAt] = useState(promo?.expires_at ?? '');
  const [legs, setLegs] = useState(promo?.legs ?? '');
  const [odds, setOdds] = useState(promo?.odds ?? '');
  const [amount, setAmount] = useState(promo?.amount ?? '');
  const [maxBonus, setMaxBonus] = useState(promo?.max_bonus != null ? String(promo.max_bonus) : '');
  const [status, setStatus] = useState<BetPromoStatus>(promo?.status ?? 'active');
  const [notes, setNotes] = useState(promo?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!sportsbook.trim()) return setError('Sportsbook is required.');
    if (!description.trim()) return setError('A short description is required.');
    setSaving(true);
    setError(null);
    try {
      await onSave({
        sportsbook: sportsbook.trim(),
        description: description.trim(),
        promo_type: promoType,
        expires_at: expiresAt || null,
        legs: legs.trim() || undefined,
        odds: odds.trim() || undefined,
        amount: amount.trim() || undefined,
        max_bonus: maxBonus.trim() !== '' ? Number(maxBonus) : null,
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
          <input list="bets-sportsbooks-promo" placeholder="DraftKings" value={sportsbook} onChange={(e) => setSportsbook(e.target.value)} />
          <datalist id="bets-sportsbooks-promo">
            {COMMON_SPORTSBOOKS.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </label>
        <label className="bets-form__field">
          <span>Description</span>
          <input placeholder="NFL SGP odds boost" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="bets-form__row">
          <label className="bets-form__field">
            <span>Type</span>
            <input list="bets-promo-types" value={promoType} onChange={(e) => setPromoType(e.target.value)} />
            <datalist id="bets-promo-types">
              {PROMO_TYPES.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <label className="bets-form__field">
            <span>Expires</span>
            <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </label>
        </div>
        <div className="bets-form__row">
          <label className="bets-form__field">
            <span>Legs</span>
            <input placeholder="2+" value={legs} onChange={(e) => setLegs(e.target.value)} />
          </label>
          <label className="bets-form__field">
            <span>Odds</span>
            <input placeholder="+400" value={odds} onChange={(e) => setOdds(e.target.value)} />
          </label>
        </div>
        <div className="bets-form__row">
          <label className="bets-form__field">
            <span>Amount</span>
            <input placeholder="10%" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="bets-form__field">
            <span>Max</span>
            <input placeholder="20" inputMode="decimal" value={maxBonus} onChange={(e) => setMaxBonus(e.target.value)} />
          </label>
        </div>
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
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
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

function promoIsStale(promo: BetPromo): boolean {
  return promo.status === 'active' && !!promo.expires_at && promo.expires_at < todayIso;
}

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
        <div className="bets-log card" style={{ marginTop: 12 }}>
          {promos.map((p) => {
            const stale = promoIsStale(p);
            return (
              <div key={p.id} className="bets-log__row">
                <div className="bets-log__main">
                  <span className="bets-log__date">{p.sportsbook}</span>
                  <span className="bets-log__pick">{p.description}</span>
                  <span className="bets-log__meta">
                    {p.promo_type}
                    {p.legs ? ` · ${p.legs} legs` : ''}
                    {p.odds ? ` · ${p.odds}` : ''}
                    {p.amount ? ` · ${p.amount}` : ''}
                    {p.max_bonus != null ? ` · max $${p.max_bonus}` : ''}
                    {p.expires_at ? ` · expires ${p.expires_at}` : ''}
                  </span>
                </div>
                <span className={`bets__result-badge ${stale ? 'bets__result-badge--loss' : p.status === 'active' ? 'bets__result-badge--win' : 'bets__result-badge--push'}`}>
                  {stale ? 'Expired' : STATUS_OPTIONS.find((s) => s.value === p.status)?.label}
                </span>
                <KebabMenu
                  items={[
                    ...(p.status === 'active'
                      ? [{ label: 'Mark used', onClick: () => onUpdate(p.id, { status: 'used' }) }]
                      : p.status === 'used'
                        ? [{ label: 'Mark active', onClick: () => onUpdate(p.id, { status: 'active' }) }]
                        : []),
                    { label: 'Edit', onClick: () => setEditing(p) },
                    { label: 'Delete', onClick: () => setDeleting(p), danger: true, separatorBefore: true },
                  ]}
                />
              </div>
            );
          })}
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

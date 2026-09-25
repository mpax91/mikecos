import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { RewardsMerchant } from '../../api/types';
import { Modal } from '../../components/Modal';
import { ConfirmModal } from '../../components/ConfirmModal';

interface FormState {
  name: string;
  aliases: string;
  category: string;
  notes: string;
}

const EMPTY_FORM: FormState = { name: '', aliases: '', category: '', notes: '' };

function formFrom(m: RewardsMerchant): FormState {
  return { name: m.name, aliases: m.aliases ?? '', category: m.category, notes: m.notes ?? '' };
}

/** Settings' view of the merchant -> category directory Find resolves
 * unrecognized queries against (see 0058_rewards_merchant_intelligence.sql
 * and utils/rewards.ts's resolveMerchant). Most entries land here from the
 * quarterly research import or Find's own "teach MikeOS this merchant"
 * quick-add — this screen is where a bad or stale one gets fixed or
 * removed, same relationship WalletCategoriesPanel has to Wallet's
 * category picklist. */
export function RewardsMerchantsPanel() {
  const [merchants, setMerchants] = useState<RewardsMerchant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<RewardsMerchant | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [deleting, setDeleting] = useState<RewardsMerchant | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function load() {
    api
      .listRewardsMerchants()
      .then((res) => {
        setMerchants(res);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    load();
  }, []);

  async function handleAdd() {
    if (!form.name.trim() || !form.category.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.createRewardsMerchant({ name: form.name.trim(), aliases: form.aliases.trim() || null, category: form.category.trim(), notes: form.notes.trim() || null });
      setAdding(false);
      load();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleEdit() {
    if (!editing || !form.name.trim() || !form.category.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.updateRewardsMerchant(editing.id, {
        name: form.name.trim(),
        aliases: form.aliases.trim() || null,
        category: form.category.trim(),
        notes: form.notes.trim() || null,
      });
      setEditing(null);
      load();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(m: RewardsMerchant) {
    setMerchants((prev) => (prev ? prev.filter((x) => x.id !== m.id) : prev));
    await api.deleteRewardsMerchant(m.id);
    setDeleting(null);
  }

  if (error) return <div className="empty-state">Couldn't load merchants: {error}</div>;
  if (!merchants) return <div className="empty-state">Loading…</div>;

  function renderForm() {
    return (
      <>
        <div className="settings-page__form-row">
          <input autoFocus placeholder="Merchant name (e.g. Rhoback)" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          <input placeholder="Category (e.g. Online Shopping)" value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} />
        </div>
        <input placeholder="Aliases, comma-separated (optional)" value={form.aliases} onChange={(e) => setForm((f) => ({ ...f, aliases: e.target.value }))} />
        <textarea placeholder="Notes (optional)" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} rows={2} />
        {saveError && <div className="settings-page__rrule-error">{saveError}</div>}
      </>
    );
  }

  return (
    <div className="settings-page__section">
      <div className="toolbar-row">
        <h2 className="settings-page__section-title">Rewards Merchants</h2>
        <button className="btn" onClick={() => { setForm(EMPTY_FORM); setSaveError(null); setAdding(true); }}>
          + Add Merchant
        </button>
      </div>
      <p className="settings-page__section-hint">
        What lets Find understand a specific merchant name ("Rhoback," "Fios") as a spend category it already has
        a card for. Most of these come from the quarterly research import or Find's own "teach MikeOS" prompt —
        this is where to fix or remove one.
      </p>

      {merchants.length === 0 ? (
        <div className="empty-state">No merchants taught yet — they'll show up here as Find learns them.</div>
      ) : (
        <div className="manage-list">
          {merchants.map((m) => (
            <div className="manage-row" key={m.id}>
              <div className="manage-row__body" onClick={() => { setForm(formFrom(m)); setSaveError(null); setEditing(m); }}>
                <div className="manage-row__title">{m.name}</div>
                <div className="settings-page__section-hint" style={{ margin: 0 }}>
                  {m.category}
                  {m.aliases ? ` · aka ${m.aliases}` : ''}
                </div>
              </div>
              <div className="manage-row__actions">
                <button type="button" onClick={() => { setForm(formFrom(m)); setSaveError(null); setEditing(m); }} title="Edit">
                  ✎
                </button>
                <button type="button" onClick={() => setDeleting(m)} title="Delete">
                  🗑
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <Modal title="Add Merchant" onClose={() => setAdding(false)}>
          {renderForm()}
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button className="btn" onClick={handleAdd} disabled={!form.name.trim() || !form.category.trim() || saving}>
              {saving ? 'Adding…' : 'Add'}
            </button>
          </div>
        </Modal>
      )}

      {editing && (
        <Modal title={`Edit "${editing.name}"`} onClose={() => setEditing(null)}>
          {renderForm()}
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="btn" onClick={handleEdit} disabled={!form.name.trim() || !form.category.trim() || saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmModal
          title="Delete this merchant?"
          body={`"${deleting.name}" will stop being recognized in Find — its category won't be affected, just this name/alias lookup.`}
          onConfirm={() => handleDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

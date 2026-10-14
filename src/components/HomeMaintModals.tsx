import { useState } from 'react';
import { api } from '../api/client';
import type { HomeMaintItem, HomeMaintRecord } from '../api/types';
import { ConfirmModal } from './ConfirmModal';
import { Modal } from './Modal';

/** Add / edit one service record (Home → Maintenance). Drive receipts are
 * edited in place — once edited, a rescan leaves the fields alone until the
 * file is renamed; "Use File Name" goes back to what the name says. */
export function HomeMaintRecordModal({
  record,
  systems,
  defaults,
  onClose,
  onSaved,
}: {
  record: HomeMaintRecord | null;
  systems: string[];
  defaults?: { system?: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = !record;
  const [date, setDate] = useState(record?.date ?? '');
  const [system, setSystem] = useState(record?.system ?? defaults?.system ?? '');
  const [vendor, setVendor] = useState(record?.vendor ?? '');
  const [service, setService] = useState(record?.service ?? '');
  const [amount, setAmount] = useState(record?.amount != null ? String(record.amount) : '');
  const [notes, setNotes] = useState(record?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const canDelete = record && (record.source === 'manual' || record.missing);

  async function save() {
    const amt = amount.replace(/[$,\s]/g, '');
    if (amt && !/^\d+(\.\d{1,2})?$/.test(amt)) {
      setError('Amount should be a number like 525 or 525.00');
      return;
    }
    setSaving(true);
    setError(null);
    const body = { date, system, vendor: vendor.trim() || null, service: service.trim() || null, amount: amt ? Number(amt) : null, notes: notes.trim() || null };
    try {
      if (isNew) await api.createHomeMaintRecord(body);
      else await api.updateHomeMaintRecord(record!.id, body);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  async function reset() {
    setSaving(true);
    try {
      await api.updateHomeMaintRecord(record!.id, { reset: true });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  async function doDelete() {
    try {
      await api.deleteHomeMaintRecord(record!.id);
      onSaved();
    } catch (e) {
      setConfirmDelete(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal title={isNew ? 'Add Service' : 'Edit Service'} onClose={onClose} className="home-net-modal">
      <div className="home-net-modal__form">
        {record?.fileName && (
          <div className="hm-file-line">
            🧾{' '}
            {record.fileUrl ? (
              <a href={record.fileUrl} target="_blank" rel="noreferrer">
                {record.fileName} ↗
              </a>
            ) : (
              record.fileName
            )}
            {record.missing && <span className="hm-chip hm-chip--overdue">Not in Folder</span>}
          </div>
        )}
        {record?.parseError && <div className="home-net-modal__error">{record.parseError}</div>}
        <div className="bar-item-modal__row">
          <label className="wallet-editor__field">
            <span>Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} autoFocus={isNew} />
          </label>
          <label className="wallet-editor__field">
            <span>System</span>
            <select value={system} onChange={(e) => setSystem(e.target.value)}>
              <option value="" disabled>
                Choose…
              </option>
              {systems.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="wallet-editor__field">
          <span>Vendor</span>
          <input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="e.g. ABC Septic" />
        </label>
        <label className="wallet-editor__field">
          <span>Service</span>
          <input value={service} onChange={(e) => setService(e.target.value)} placeholder="e.g. Pump-Out" />
        </label>
        <label className="wallet-editor__field">
          <span>Amount ($)</span>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="e.g. 525" />
        </label>
        <label className="wallet-editor__field">
          <span>Notes</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything the receipt said — e.g. sludge level, baffle condition, “recommend sooner”" />
        </label>
        {error && <div className="home-net-modal__error">{error}</div>}
      </div>
      <div className="modal__actions">
        {canDelete && (
          <button className="btn btn--ghost" style={{ color: 'var(--color-danger, #c0392b)', marginRight: 'auto' }} onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
        )}
        {record?.source === 'drive' && record.edited && (
          <button className="btn btn--ghost" style={canDelete ? undefined : { marginRight: 'auto' }} onClick={reset} disabled={saving} title="Go back to what the file name says">
            Use File Name
          </button>
        )}
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={save} disabled={!date || !system || saving}>
          {isNew ? 'Add' : 'Save'}
        </button>
      </div>
      {confirmDelete && record && <ConfirmModal title="Delete this service?" body="It will be removed from Home → Maintenance." onConfirm={doDelete} onCancel={() => setConfirmDelete(false)} />}
    </Modal>
  );
}

export const INTERVAL_CHOICES: { months: number; label: string }[] = [
  { months: 3, label: 'Every 3 Months' },
  { months: 6, label: 'Every 6 Months' },
  { months: 12, label: 'Every Year' },
  { months: 24, label: 'Every 2 Years' },
  { months: 36, label: 'Every 3 Years' },
  { months: 48, label: 'Every 4 Years' },
  { months: 60, label: 'Every 5 Years' },
  { months: 120, label: 'Every 10 Years' },
];

/** Add / edit a recurring item (Settings → Home Maintenance). */
export function HomeMaintItemModal({
  item,
  systems,
  preset,
  onClose,
  onSaved,
}: {
  item: HomeMaintItem | null;
  systems: string[];
  preset?: { name: string; system: string; matchWords: string; intervalMonths: number; leadDays: number };
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = !item;
  const start = item ?? preset;
  const [name, setName] = useState(start?.name ?? '');
  const [system, setSystem] = useState(start?.system ?? '');
  const [matchWords, setMatchWords] = useState(start?.matchWords ?? '');
  const [interval, setIntervalMonths] = useState(start?.intervalMonths != null ? String(start.intervalMonths) : '12');
  const [leadDays, setLeadDays] = useState(String(start?.leadDays ?? 30));
  const [dueOverride, setDueOverride] = useState(item?.overrideActive ? (item.dueOverride ?? '') : '');
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const custom = interval !== '' && !INTERVAL_CHOICES.some((c) => String(c.months) === interval);

  async function save() {
    const months = interval === '' ? null : Number(interval);
    const lead = Number(leadDays);
    if (months !== null && (!Number.isInteger(months) || months < 1)) return setError('How often should be a whole number of months');
    if (!Number.isInteger(lead) || lead < 0) return setError('Remind me should be a whole number of days');
    setSaving(true);
    setError(null);
    const body = {
      name: name.trim(),
      system,
      matchWords: matchWords.trim() || null,
      intervalMonths: months,
      leadDays: lead,
      notes: notes.trim() || null,
      ...(dueOverride !== (item?.overrideActive ? (item.dueOverride ?? '') : '') ? { dueOverride: dueOverride || null } : {}),
    };
    try {
      if (isNew) await api.createHomeMaintItem(body);
      else await api.updateHomeMaintItem(item!.id, body);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  async function doDelete() {
    await api.deleteHomeMaintItem(item!.id);
    onSaved();
  }

  return (
    <Modal title={isNew ? 'Add Recurring Item' : `Edit “${item!.name}”`} onClose={onClose} className="home-net-modal">
      <div className="home-net-modal__form">
        <label className="wallet-editor__field">
          <span>Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Septic Pump-Out" />
        </label>
        <div className="bar-item-modal__row">
          <label className="wallet-editor__field">
            <span>System</span>
            <select value={system} onChange={(e) => setSystem(e.target.value)}>
              <option value="" disabled>
                Choose…
              </option>
              {systems.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="wallet-editor__field">
            <span>How Often</span>
            <select value={custom ? 'custom' : interval} onChange={(e) => setIntervalMonths(e.target.value === 'custom' ? '18' : e.target.value)}>
              {INTERVAL_CHOICES.map((c) => (
                <option key={c.months} value={String(c.months)}>
                  {c.label}
                </option>
              ))}
              <option value="custom">Custom…</option>
              <option value="">No Schedule (History Only)</option>
            </select>
          </label>
        </div>
        {custom && (
          <label className="wallet-editor__field">
            <span>Every (Months)</span>
            <input value={interval} onChange={(e) => setIntervalMonths(e.target.value.replace(/\D/g, ''))} inputMode="numeric" />
          </label>
        )}
        <div className="bar-item-modal__row">
          <label className="wallet-editor__field">
            <span>Remind Me (Days Before)</span>
            <input value={leadDays} onChange={(e) => setLeadDays(e.target.value.replace(/\D/g, ''))} inputMode="numeric" />
          </label>
          <label className="wallet-editor__field">
            <span>Next Due (Optional)</span>
            <input type="date" value={dueOverride} onChange={(e) => setDueOverride(e.target.value)} />
          </label>
        </div>
        <label className="wallet-editor__field">
          <span>Counts Receipts That Mention</span>
          <input value={matchWords} onChange={(e) => setMatchWords(e.target.value)} placeholder="e.g. pump — leave blank for any receipt in this system" />
        </label>
        <p className="wallet-editor__hint">
          The newest matching receipt sets the next due date. Match words keep repairs from resetting a routine service (HVAC “tune, service” skips a capacitor repair). Next Due is for when there’s no
          receipt yet — a newer receipt replaces it.
        </p>
        <label className="wallet-editor__field">
          <span>Notes</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {error && <div className="home-net-modal__error">{error}</div>}
      </div>
      <div className="modal__actions">
        {!isNew && (
          <button className="btn btn--ghost" style={{ color: 'var(--color-danger, #c0392b)', marginRight: 'auto' }} onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
        )}
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={save} disabled={!name.trim() || !system || saving}>
          {isNew ? 'Add' : 'Save'}
        </button>
      </div>
      {confirmDelete && item && (
        <ConfirmModal title="Delete this item?" body={`“${item.name}” stops being tracked. Receipts stay in the history.`} onConfirm={doDelete} onCancel={() => setConfirmDelete(false)} />
      )}
    </Modal>
  );
}

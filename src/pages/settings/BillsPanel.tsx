import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { Bill } from '../../api/types';
import { Modal } from '../../components/Modal';
import { ConfirmModal } from '../../components/ConfirmModal';

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const mdy = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}/${y}`;
};
const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

interface FormState {
  bill: Bill | null; // null = new manual bill
  name: string;
  dueDay: number | null; // null = follow the statements (statement bills)
  autopay: boolean | null; // null = follow the statements (statement bills)
  amount: string;
}

/** Settings → Bills & Due Dates (worker/src/bills.ts). Statement accounts
 * (bills and credit cards) appear on their own with the due day and
 * Auto-Pay the statements show; Mike can override either (his edit wins
 * until he resets it), turn a bill off, or add bills that have no
 * statements. Not on Auto-Pay = a monthly "Pay …" task on the due date;
 * on Auto-Pay = a non-checkable Auto-Pay marker on the Calendar. */
export function BillsPanel() {
  const [bills, setBills] = useState<Bill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Bill | null>(null);

  function load() {
    api
      .listBills()
      .then((res) => {
        setBills(res.bills);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }
  useEffect(load, []);

  function openAdd() {
    setForm({ bill: null, name: '', dueDay: 1, autopay: false, amount: '' });
    setSaveError(null);
  }
  function openEdit(b: Bill) {
    setForm({
      bill: b,
      name: b.name,
      dueDay: b.source === 'statement' && !b.dueEdited ? null : b.dueDay,
      autopay: b.source === 'statement' && !b.autopayEdited ? null : b.autopay,
      amount: b.amount != null ? String(b.amount) : '',
    });
    setSaveError(null);
  }

  async function toggle(b: Bill) {
    setBills((prev) => prev?.map((x) => (x.id === b.id ? { ...x, enabled: !x.enabled } : x)) ?? prev);
    await api.updateBill(b.id, { enabled: !b.enabled });
    load();
  }

  async function save() {
    if (!form) return;
    const amount = form.amount.trim() === '' ? null : Number(form.amount.replace(/[$,]/g, ''));
    if (amount !== null && !Number.isFinite(amount)) return setSaveError('Amount must be a number');
    setSaving(true);
    setSaveError(null);
    try {
      if (!form.bill) {
        await api.createBill({ name: form.name.trim(), dueDay: form.dueDay ?? 1, amount, autopay: !!form.autopay });
      } else if (form.bill.source === 'manual') {
        await api.updateBill(form.bill.id, { name: form.name.trim(), dueDay: form.dueDay ?? 1, amount, autopay: !!form.autopay });
      } else {
        await api.updateBill(form.bill.id, { dueDay: form.dueDay, autopay: form.autopay });
      }
      setForm(null);
      load();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(b: Bill) {
    setBills((prev) => prev?.filter((x) => x.id !== b.id) ?? prev);
    setDeleting(null);
    await api.deleteBill(b.id);
    load();
  }

  if (error) return <div className="empty-state">Couldn't load bills: {error}</div>;
  if (!bills) return <div className="empty-state">Loading…</div>;

  const fromStatements = bills.filter((b) => b.source === 'statement');
  const manual = bills.filter((b) => b.source === 'manual');

  const row = (b: Bill) => {
    const meta: string[] = [];
    meta.push(b.dueDay != null ? `Due the ${ordinal(b.dueDay)}${b.dueEdited ? ' (Edited)' : ''}` : 'No due day yet');
    if (b.enabled && b.nextDue) meta.push(`Next ${mdy(b.nextDue)}`);
    if (b.latest) meta.push(`Latest ${money(b.latest.amount)}`);
    else if (b.amount != null) meta.push(`About ${money(b.amount)}`);
    return (
      <div key={b.id} className={`settings-page__calendar-row${b.enabled ? '' : ' is-inactive'}`}>
        <button
          type="button"
          className="settings-page__recurring-toggle"
          title={b.enabled ? 'On — click to turn off' : 'Off — click to turn on'}
          onClick={() => toggle(b)}
        >
          {b.enabled ? '●' : '○'}
        </button>
        <div className="settings-page__calendar-main" onClick={() => openEdit(b)}>
          <div className="settings-page__calendar-label">{b.name}</div>
          <div className="settings-page__calendar-meta">{meta.join(' · ')}</div>
          {b.enabled && b.openTask && (
            <div className="settings-page__calendar-meta">
              Task: {b.openTask.title}
              {b.openTask.dueDate ? ` · due ${mdy(b.openTask.dueDate)}` : ''}
            </div>
          )}
        </div>
        {!b.enabled ? (
          <span className="settings-page__calendar-badge is-off">Off</span>
        ) : b.autopay ? (
          <span className="settings-page__calendar-badge is-ok" title="No task — shown on the Calendar">
            Auto-Pay{b.autopayEdited ? ' (Edited)' : ''}
          </span>
        ) : (
          <span className="settings-page__calendar-badge is-off" title="A Pay task each month on the due date">
            Monthly Task{b.autopayEdited ? ' (Edited)' : ''}
          </span>
        )}
        {b.source === 'manual' ? (
          <button type="button" className="settings-page__recurring-delete" title="Delete" onClick={() => setDeleting(b)}>
            ✕
          </button>
        ) : (
          <span className="settings-page__recurring-delete" aria-hidden style={{ visibility: 'hidden' }}>
            ✕
          </span>
        )}
      </div>
    );
  };

  const isStatement = form?.bill?.source === 'statement';
  const b = form?.bill;

  return (
    <div className="settings-page__section">
      <div className="toolbar-row">
        <h2 className="settings-page__section-title">Bills &amp; Due Dates</h2>
        <button className="btn" onClick={openAdd}>
          + Add Bill
        </button>
      </div>
      <p className="settings-page__section-hint">
        Bills not on Auto-Pay get a "Pay …" task each month on the due date — it shows the amount once that month's
        statement is in, and checks itself off when the next statement shows it paid. Auto-Pay bills get no task; they
        show on the Calendar as Auto-Pay. Accounts with statements follow their statements unless you edit them. Click
        the dot to turn a bill on or off.
      </p>

      <h3 className="settings-page__field-label">From Statements</h3>
      {fromStatements.length === 0 ? (
        <div className="empty-state">
          No bill or credit card accounts are live yet — go live in <Link to="/settings?cat=statements">Statements</Link>.
        </div>
      ) : (
        <div className="settings-page__calendar-list card">{fromStatements.map(row)}</div>
      )}

      <h3 className="settings-page__field-label">Added by Hand</h3>
      {manual.length === 0 ? (
        <div className="empty-state">None yet — use + Add Bill for bills without statements.</div>
      ) : (
        <div className="settings-page__calendar-list card">{manual.map(row)}</div>
      )}

      {form && (
        <Modal title={!b ? 'Add Bill' : `Edit ${b.name}`} onClose={() => setForm(null)}>
          {!isStatement && (
            <>
              <label className="settings-page__field-label">Name</label>
              <input autoFocus placeholder="e.g. Netflix" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </>
          )}

          <label className="settings-page__field-label">Due Day</label>
          <select
            value={form.dueDay == null ? '' : String(form.dueDay)}
            onChange={(e) => setForm({ ...form, dueDay: e.target.value === '' ? null : Number(e.target.value) })}
          >
            {isStatement && (
              <option value="">
                Follow Statements{b?.autoDueDay != null ? ` (${ordinal(b.autoDueDay)})` : ' (not known yet)'}
              </option>
            )}
            {DAYS.map((d) => (
              <option key={d} value={d}>
                {ordinal(d)}
                {d >= 29 ? ' (or the last day)' : ''}
              </option>
            ))}
          </select>

          <label className="settings-page__field-label">Auto-Pay</label>
          <select
            value={form.autopay == null ? '' : form.autopay ? 'yes' : 'no'}
            onChange={(e) => setForm({ ...form, autopay: e.target.value === '' ? null : e.target.value === 'yes' })}
          >
            {isStatement && (
              <option value="">
                Follow Statements{b?.autoAutopay != null ? ` (${b.autoAutopay ? 'Yes' : 'No'})` : ' (No)'}
              </option>
            )}
            <option value="no">No — Monthly Pay Task</option>
            <option value="yes">Yes — Calendar Only</option>
          </select>

          {!isStatement && (
            <>
              <label className="settings-page__field-label">Typical Amount (Optional)</label>
              <input placeholder="e.g. 15.49" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            </>
          )}

          {saveError && <div className="settings-page__rrule-error">{saveError}</div>}

          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => setForm(null)}>
              Cancel
            </button>
            <button className="btn" onClick={save} disabled={saving || (!isStatement && !form.name.trim())}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmModal
          title="Delete this bill?"
          body={`"${deleting.name}" and its open Pay task (if any) will be removed.`}
          onConfirm={() => remove(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

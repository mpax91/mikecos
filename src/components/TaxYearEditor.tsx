import { useState } from 'react';
import { api } from '../api/client';
import type { TaxFederal, TaxFilingStatus, TaxItemized, TaxReturnRecord, TaxStateReturn } from '../api/types';
import { ConfirmModal } from './ConfirmModal';
import { Modal } from './Modal';
import { FEDERAL_GROUPS, ITEMIZED_FIELDS, STATE_FIELDS, STATUS_LABEL } from '../utils/taxFields';

const EMPTY_FED = Object.fromEntries(FEDERAL_GROUPS.flatMap((g) => g.fields.map(([k]) => [k, null]))) as unknown as TaxFederal;
const emptyState = (): TaxStateReturn => ({ tax: null, credits: null, total_tax: null, withholding: null, refund: null, amount_owed: null });
const emptyItemized = (): TaxItemized => ({ medical: null, salt_paid: null, salt_deducted: null, real_estate_tax: null, mortgage_interest: null, charity: null, other: null, total: null });

export function blankTaxYear(year: number, status: TaxFilingStatus): TaxReturnRecord {
  return {
    year,
    filing_status: status,
    prepared_by: null,
    amended: false,
    source_files: [],
    people: [],
    federal: { ...EMPTY_FED, deduction_type: null, credit_detail: null, other_taxes_detail: null },
    itemized: null,
    ny: emptyState(),
    ct: null,
    dependents: null,
    checks: {},
    doubts: [],
    notes: [],
  };
}

const toNum = (s: string): number | null => {
  const t = s
    .replace(/[$,\s]/g, '')
    .replace(/^\((.*)\)$/, '-$1')
    .replace(/^−/, '-');
  if (!t) return null;
  const v = Number(t);
  return Number.isFinite(v) ? Math.round(v) : null;
};

function NumField({ label, value, onChange }: { label: string; value: number | null | undefined; onChange: (v: number | null) => void }) {
  const [text, setText] = useState(value === null || value === undefined ? '' : String(value));
  return (
    <label className="wallet-editor__field tax-editor__num">
      <span>{label}</span>
      <input
        inputMode="decimal"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(toNum(e.target.value));
        }}
        placeholder="—"
      />
    </label>
  );
}

/** Add or edit one tax year. Every line is optional — a year with only the
 * e-file totals (AGI, total tax, refund) still charts. Mike's save wins over
 * the original import (source 'manual'). */
export function TaxYearEditor({
  initial,
  isNew,
  takenYears,
  onClose,
  onSaved,
  onDeleted,
}: {
  initial: TaxReturnRecord;
  isNew: boolean;
  takenYears: number[];
  onClose: () => void;
  onSaved: (r: TaxReturnRecord) => void;
  onDeleted: (year: number) => void;
}) {
  const [r, setR] = useState<TaxReturnRecord>(() => JSON.parse(JSON.stringify(initial)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const setFed = (k: keyof TaxFederal, v: unknown) => setR((x) => ({ ...x, federal: { ...x.federal, [k]: v } }));
  const setState = (which: 'ny' | 'ct', k: keyof TaxStateReturn, v: number | null) => setR((x) => ({ ...x, [which]: { ...(x[which] ?? emptyState()), [k]: v } }));
  const lines = (a: string[]) => a.join('\n');
  const yearTaken = isNew && takenYears.includes(r.year);

  async function save() {
    if (saving || yearTaken) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await api.saveTaxYear(r));
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  return (
    <Modal title={isNew ? 'Add Tax Year' : `Edit ${initial.year} Return`} onClose={onClose} className="tax-editor">
      <div className="tax-editor__form">
        <div className="tax-editor__row">
          <label className="wallet-editor__field">
            <span>Tax Year</span>
            <input type="number" value={r.year} disabled={!isNew} onChange={(e) => setR({ ...r, year: Number(e.target.value) })} />
          </label>
          <label className="wallet-editor__field">
            <span>Filing Status</span>
            <select value={r.filing_status} onChange={(e) => setR({ ...r, filing_status: e.target.value as TaxFilingStatus })}>
              {Object.entries(STATUS_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="wallet-editor__field">
            <span>Prepared By</span>
            <input value={r.prepared_by ?? ''} onChange={(e) => setR({ ...r, prepared_by: e.target.value || null })} placeholder="e.g. TurboTax, a CPA" />
          </label>
          <NumField label="Dependents" value={r.dependents} onChange={(v) => setR({ ...r, dependents: v })} />
        </div>
        <label className="tax-editor__check">
          <input type="checkbox" checked={r.amended} onChange={(e) => setR({ ...r, amended: e.target.checked })} /> Amended Return (these are the amended figures)
        </label>
        {yearTaken && <p className="wallet-editor__error">{r.year} is already in — edit it from its row instead.</p>}

        {FEDERAL_GROUPS.map((g) => (
          <fieldset key={g.title} className="tax-editor__group">
            <legend>Federal · {g.title}</legend>
            {g.title === 'Deductions' && (
              <label className="wallet-editor__field tax-editor__num">
                <span>Deduction Type</span>
                <select value={r.federal.deduction_type ?? ''} onChange={(e) => setFed('deduction_type', e.target.value || null)}>
                  <option value="">—</option>
                  <option value="standard">Standard</option>
                  <option value="itemized">Itemized</option>
                </select>
              </label>
            )}
            {g.fields.map(([k, label]) => (
              <NumField key={k} label={label} value={r.federal[k] as number | null} onChange={(v) => setFed(k, v)} />
            ))}
          </fieldset>
        ))}

        {r.federal.deduction_type === 'itemized' && (
          <fieldset className="tax-editor__group">
            <legend>Itemized Deductions (Schedule A)</legend>
            {ITEMIZED_FIELDS.map(([k, label]) => (
              <NumField key={k} label={label} value={r.itemized?.[k]} onChange={(v) => setR((x) => ({ ...x, itemized: { ...(x.itemized ?? emptyItemized()), [k]: v } }))} />
            ))}
          </fieldset>
        )}

        {(['ny', 'ct'] as const).map((s) => (
          <fieldset key={s} className="tax-editor__group">
            <legend>
              <label className="tax-editor__check">
                <input type="checkbox" checked={!!r[s]} onChange={(e) => setR({ ...r, [s]: e.target.checked ? emptyState() : null })} />
                {s === 'ny' ? 'New York Return' : 'Connecticut Return (Nonresident)'}
              </label>
            </legend>
            {r[s] && STATE_FIELDS.map(([k, label]) => <NumField key={k} label={label} value={r[s]?.[k] as number | null} onChange={(v) => setState(s, k, v)} />)}
          </fieldset>
        ))}

        <label className="wallet-editor__field">
          <span>Notes (One per Line)</span>
          <textarea rows={3} value={lines(r.notes)} onChange={(e) => setR({ ...r, notes: e.target.value.split('\n') })} />
        </label>
        <label className="wallet-editor__field">
          <span>Double-Check (One per Line — Clear Once Verified)</span>
          <textarea rows={3} value={lines(r.doubts)} onChange={(e) => setR({ ...r, doubts: e.target.value.split('\n') })} />
        </label>
        {error && <p className="wallet-editor__error">{error}</p>}
      </div>
      <div className="modal__actions">
        {!isNew && (
          <button type="button" className="btn btn--ghost" style={{ color: 'var(--color-danger, #c0392b)', marginRight: 'auto' }} onClick={() => setConfirmDelete(true)}>
            Delete Year
          </button>
        )}
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn" disabled={saving || yearTaken} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {confirmDelete && (
        <ConfirmModal
          title={`Delete ${initial.year}?`}
          body="Removes this year's figures from MikeOS. The PDFs in Drive aren't touched."
          onConfirm={async () => {
            await api.deleteTaxYear(initial.year);
            onDeleted(initial.year);
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </Modal>
  );
}

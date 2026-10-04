import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { BetOption, BetOptionCategory } from '../../api/types';

const OPTION_CATEGORIES: { id: BetOptionCategory; label: string; hint: string }[] = [
  { id: 'bet_type', label: 'Bet Type', hint: 'Straight, Parlay, SGP…' },
  { id: 'tipper', label: 'Tipper', hint: 'Who the pick came from — free text on the betslip, but these show up as suggestions.' },
  { id: 'line', label: 'Line', hint: 'ATS, Mixed, ML, o/u…' },
  { id: 'result', label: 'Result', hint: 'Win, Loss, Cashed Out…' },
];

/** Add/remove/edit for one of the four Bets lists (Bet Type, Tipper,
 * Line, Result) — Mike's own ask: "build a proper settings screen...
 * that allows me to add/remove/edit any of these fields". Editing only
 * ever changes an option's label, never its stored value — see
 * worker/migrations/0084_bet_options_tipper_line.sql's header for why. */
function OptionListEditor({
  category,
  label,
  hint,
  options,
  onCreate,
  onUpdate,
  onDelete,
}: {
  category: BetOptionCategory;
  label: string;
  hint: string;
  options: BetOption[];
  onCreate: (category: BetOptionCategory, value: string) => Promise<void>;
  onUpdate: (id: string, newLabel: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [adding, setAdding] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const rows = options.filter((o) => o.category === category);

  async function handleAdd() {
    if (!adding.trim()) return;
    setBusy(true);
    try {
      await onCreate(category, adding.trim());
      setAdding('');
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveEdit() {
    if (!editingId || !editingLabel.trim()) return;
    setBusy(true);
    try {
      await onUpdate(editingId, editingLabel.trim());
      setEditingId(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bets-settings__card card">
      <div className="bets-settings__card-title">{label}</div>
      <div className="bets-settings__card-hint">{hint}</div>
      <div className="bets-settings__list">
        {rows.map((o) => (
          <div key={o.id} className="bets-settings__row">
            {editingId === o.id ? (
              <>
                <input className="bets-settings__edit-input" autoFocus value={editingLabel} onChange={(e) => setEditingLabel(e.target.value)} />
                <button type="button" className="link-btn" disabled={busy} onClick={handleSaveEdit}>
                  Save
                </button>
                <button type="button" className="link-btn" disabled={busy} onClick={() => setEditingId(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <span className="bets-settings__row-label">{o.label}</span>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setEditingId(o.id);
                    setEditingLabel(o.label);
                  }}
                >
                  Edit
                </button>
                <button type="button" className="link-btn bets-settings__danger" disabled={busy} onClick={() => onDelete(o.id)}>
                  Remove
                </button>
              </>
            )}
          </div>
        ))}
        {rows.length === 0 && <div className="bets-settings__row-label bets-settings__empty">No options yet.</div>}
      </div>
      <div className="bets-settings__add">
        <input
          placeholder={`Add a ${label.toLowerCase()}…`}
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd();
          }}
        />
        <button type="button" className="btn btn--ghost" disabled={busy || !adding.trim()} onClick={handleAdd}>
          Add
        </button>
      </div>
    </div>
  );
}

/** Settings → Bets: the four editable dropdown lists the betslip uses
 * (Bet Type, Tipper, Line, Result). Moved here from a Settings tab inside
 * Bets itself so every app's configuration lives in one place; Bets links
 * over with a gear icon, the same way News does. */
export function BetOptionsPanel() {
  const [options, setOptions] = useState<BetOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listBetOptions().then(setOptions).catch((e) => setError(String(e)));
  }, []);

  async function onCreate(category: BetOptionCategory, value: string) {
    const created = await api.createBetOption({ category, value });
    setOptions((prev) => [...(prev ?? []), created]);
  }

  async function onUpdate(id: string, newLabel: string) {
    const updated = await api.updateBetOption(id, { label: newLabel });
    setOptions((prev) => (prev ?? []).map((o) => (o.id === id ? updated : o)));
  }

  async function onDelete(id: string) {
    setOptions((prev) => (prev ?? []).filter((o) => o.id !== id));
    await api.deleteBetOption(id);
  }

  if (error) return <div className="empty-state">Couldn't load bet options: {error}</div>;
  if (!options) return <div className="empty-state">Loading…</div>;

  return (
    <div className="settings-page__section">
      <div className="toolbar-row">
        <h2 className="settings-page__section-title">Betslip Options</h2>
        <Link to="/bets" className="link-btn">
          Back to Bets →
        </Link>
      </div>
      <p className="settings-page__section-hint">
        The choices offered on the Log a Bet form. Renaming an option only changes how it's shown — bets already logged
        keep their value.
      </p>
      <div className="bets-settings">
        {OPTION_CATEGORIES.map((c) => (
          <OptionListEditor key={c.id} category={c.id} label={c.label} hint={c.hint} options={options} onCreate={onCreate} onUpdate={onUpdate} onDelete={onDelete} />
        ))}
      </div>
    </div>
  );
}


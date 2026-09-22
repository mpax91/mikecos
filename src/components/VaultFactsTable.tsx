import { useState } from 'react';
import type { VaultFact } from '../api/types';

/** Quick facts — a plain label/value table on the entry itself. Deliberately
 * not the old field/group/template system: no type to pick, no reusable
 * definition to create first, just "add a fact" with two text boxes. Rows
 * are added/edited/deleted inline; there's no drag-reorder in this first
 * pass (new rows land at the end) — a fine trade for how rarely a handful
 * of quick facts on one entry need reordering. */
export function VaultFactsTable({
  facts,
  onAdd,
  onUpdate,
  onDelete,
}: {
  facts: VaultFact[];
  onAdd: (label: string, value: string) => void;
  onUpdate: (fact: VaultFact, patch: { label?: string; value?: string }) => void;
  onDelete: (fact: VaultFact) => void;
  }) {
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newValue, setNewValue] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  function submitAdd() {
    const label = newLabel.trim();
    if (!label) {
      setAdding(false);
      return;
    }
    onAdd(label, newValue.trim());
    setNewLabel('');
    setNewValue('');
    setAdding(false);
  }

  function copy(fact: VaultFact) {
    if (!fact.value) return;
    navigator.clipboard.writeText(fact.value).then(() => {
      setCopiedId(fact.id);
      setTimeout(() => setCopiedId((id) => (id === fact.id ? null : id)), 1200);
    });
  }

  if (facts.length === 0 && !adding) {
    return (
      <div className="vault-facts vault-facts--empty" onClick={() => setAdding(true)}>
        <span className="vault-facts__add-label">＋ add a quick fact</span>
        <span className="vault-facts__add-hint">VIN, account #, plate — anything worth a click-to-copy row</span>
      </div>
    );
  }

  return (
    <div className="vault-facts">
      {facts.map((f) => (
        <FactRow key={f.id} fact={f} copied={copiedId === f.id} onCopy={() => copy(f)} onUpdate={onUpdate} onDelete={onDelete} />
      ))}
      {adding ? (
        <div className="vault-facts__row vault-facts__row--new">
          <input
            className="vault-facts__input vault-facts__input--label"
            placeholder="Label"
            value={newLabel}
            autoFocus
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitAdd();
              if (e.key === 'Escape') setAdding(false);
            }}
          />
          <input
            className="vault-facts__input vault-facts__input--value"
            placeholder="Value"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitAdd();
              if (e.key === 'Escape') setAdding(false);
            }}
            onBlur={submitAdd}
          />
        </div>
      ) : (
        <div className="vault-facts__add" onClick={() => setAdding(true)}>
          ＋ add a fact
        </div>
      )}
    </div>
  );
}

function FactRow({
  fact,
  copied,
  onCopy,
  onUpdate,
  onDelete,
}: {
  fact: VaultFact;
  copied: boolean;
  onCopy: () => void;
  onUpdate: (fact: VaultFact, patch: { label?: string; value?: string }) => void;
  onDelete: (fact: VaultFact) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(fact.label);
  const [value, setValue] = useState(fact.value ?? '');

  function save() {
    setEditing(false);
    const patch: { label?: string; value?: string } = {};
    if (label.trim() && label.trim() !== fact.label) patch.label = label.trim();
    if (value.trim() !== (fact.value ?? '')) patch.value = value.trim();
    if (Object.keys(patch).length) onUpdate(fact, patch);
  }

  if (editing) {
    return (
      <div className="vault-facts__row vault-facts__row--editing">
        <input
          className="vault-facts__input vault-facts__input--label"
          value={label}
          autoFocus
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        <input
          className="vault-facts__input vault-facts__input--value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          onBlur={save}
        />
        <button type="button" className="vault-facts__delete" onClick={() => onDelete(fact)} title="Delete">
          ✕
        </button>
      </div>
    );
  }

  return (
    <div className="vault-facts__row" onClick={() => setEditing(true)}>
      <span className="vault-facts__label">{fact.label}</span>
      <span className="vault-facts__value">{fact.value || <span className="vault-facts__value--empty">—</span>}</span>
      {fact.value && (
        <button
          type="button"
          className="vault-facts__copy"
          onClick={(e) => {
            e.stopPropagation();
            onCopy();
          }}
          title="Copy"
        >
          {copied ? '✓' : '⧉'}
        </button>
      )}
    </div>
  );
}

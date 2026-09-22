import { useState } from 'react';
import type { VaultFact } from '../api/types';

/** Quick facts — a plain label/value table on the entry itself. Deliberately
 * not the old field/group/template system: no type to pick, no reusable
 * definition to create first, just "add a fact" with two text boxes. Rows
 * are added/edited/deleted inline, and can be promoted/demoted (swap with
 * the neighbor above/below) — no drag-and-drop, but enough to put the most
 * important fact first. */
export function VaultFactsTable({
  facts,
  onAdd,
  onUpdate,
  onDelete,
  onReorder,
}: {
  facts: VaultFact[];
  onAdd: (label: string, value: string) => void;
  onUpdate: (fact: VaultFact, patch: { label?: string; value?: string }) => void;
  onDelete: (fact: VaultFact) => void;
  onReorder: (orderedIds: string[]) => void;
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

  function move(fact: VaultFact, direction: -1 | 1) {
    const idx = facts.findIndex((f) => f.id === fact.id);
    const swapWith = idx + direction;
    if (idx === -1 || swapWith < 0 || swapWith >= facts.length) return;
    const ordered = facts.map((f) => f.id);
    [ordered[idx], ordered[swapWith]] = [ordered[swapWith], ordered[idx]];
    onReorder(ordered);
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
      {facts.map((f, i) => (
        <FactRow
          key={f.id}
          fact={f}
          copied={copiedId === f.id}
          onCopy={() => copy(f)}
          onUpdate={onUpdate}
          onDelete={onDelete}
          onMoveUp={i > 0 ? () => move(f, -1) : undefined}
          onMoveDown={i < facts.length - 1 ? () => move(f, 1) : undefined}
        />
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
  onMoveUp,
  onMoveDown,
}: {
  fact: VaultFact;
  copied: boolean;
  onCopy: () => void;
  onUpdate: (fact: VaultFact, patch: { label?: string; value?: string }) => void;
  onDelete: (fact: VaultFact) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
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
      <div className="vault-facts__move" onClick={(e) => e.stopPropagation()}>
        <button type="button" disabled={!onMoveUp} onClick={onMoveUp} title="Move up">
          ▲
        </button>
        <button type="button" disabled={!onMoveDown} onClick={onMoveDown} title="Move down">
          ▼
        </button>
      </div>
    </div>
  );
}

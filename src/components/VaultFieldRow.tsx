import { useEffect, useRef, useState } from 'react';
import type { VaultFieldType } from '../api/types';

function safeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

// Same hostname+path trimming LinksPage uses, so a Vault link field reads
// like a real link (host + trimmed path) rather than a raw pasted URL —
// Mike's explicit ask, contrasting with Evernote's flat gray-cell text.
function subtitleOf(url: string): string {
  try {
    const u = new URL(safeUrl(url));
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.hostname}${path}`;
  } catch {
    return url;
  }
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 10.5V3.5C3 2.67 3.67 2 4.5 2h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function OpenIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M6.5 3H3.5A1.5 1.5 0 002 4.5v8A1.5 1.5 0 003.5 14h8a1.5 1.5 0 001.5-1.5V9.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M9.5 2H14v4.5M14 2L7.5 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function formatDisplay(type: VaultFieldType, value: string): string {
  if (type === 'currency') {
    const n = Number(value);
    return Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : value;
  }
  if (type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  return value;
}

/** One field within a Vault entry group: a label, an editable value, and —
 * per Mike's explicit ask — a click-to-copy icon on every field plus a
 * separate click-to-open icon on link-type fields (rather than making the
 * whole cell do double duty and forcing a choice between copying and
 * following it). */
export function VaultFieldRow({
  label,
  type,
  value,
  onSave,
}: {
  label: string;
  type: VaultFieldType;
  value: string | null;
  onSave: (value: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value ?? '');
  }, [value, editing]);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  function commit() {
    setEditing(false);
    const next = draft.trim();
    if (next !== (value ?? '')) onSave(next || null);
  }

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    if (!value) return;
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  function handleOpen(e: React.MouseEvent) {
    e.stopPropagation();
    if (value) window.open(safeUrl(value), '_blank', 'noopener,noreferrer');
  }

  const isList = type === 'list';
  const listLines = isList && value ? (JSON.parse(value) as string[]) : [];

  return (
    <div className="vault-field-row">
      <div className="vault-field-row__label">{label}</div>
      <div className="vault-field-row__value-wrap">
        {editing ? (
          isList ? (
            <textarea
              ref={ref}
              className="vault-field-row__input vault-field-row__input--textarea"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                setEditing(false);
                const lines = draft.split('\n').map((l) => l.trim()).filter(Boolean);
                onSave(lines.length ? JSON.stringify(lines) : null);
              }}
              placeholder="One item per line"
              rows={Math.max(3, draft.split('\n').length)}
            />
          ) : (
            <input
              ref={ref}
              className="vault-field-row__input"
              type={type === 'date' ? 'date' : type === 'number' || type === 'currency' ? 'number' : 'text'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => e.key === 'Enter' && ref.current?.blur()}
            />
          )
        ) : (
          <div className="vault-field-row__value" onClick={() => setEditing(true)}>
            {isList ? (
              listLines.length ? (
                <ul className="vault-field-row__list">
                  {listLines.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              ) : (
                <span className="vault-field-row__placeholder">—</span>
              )
            ) : value ? (
              type === 'url' ? (
                <span className="vault-field-row__link">
                  <span className="vault-field-row__link-name">{value}</span>
                  <span className="vault-field-row__link-sub">{subtitleOf(value)}</span>
                </span>
              ) : (
                formatDisplay(type, value)
              )
            ) : (
              <span className="vault-field-row__placeholder">—</span>
            )}
          </div>
        )}

        {!isList && value && (
          <div className="vault-field-row__icons">
            <button type="button" className={`vault-field-row__icon-btn${copied ? ' is-copied' : ''}`} onClick={handleCopy} title="Copy">
              <CopyIcon />
            </button>
            {type === 'url' && (
              <button type="button" className="vault-field-row__icon-btn" onClick={handleOpen} title="Open">
                <OpenIcon />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

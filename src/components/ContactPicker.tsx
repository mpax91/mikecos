import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { PersonRef } from '../api/types';

/** Search Contacts (all of them, whatever the Work/Personal switch says) and
 * pick one or many. Typing a name nobody has offers "Add <name>" — a new
 * Work contact by default, since this is mostly for coworkers. */
export function ContactPicker({
  value,
  onChange,
  multiple = true,
  placeholder = 'Add a person…',
  newRealm = 'work',
}: {
  value: PersonRef[];
  onChange: (people: PersonRef[]) => void;
  multiple?: boolean;
  placeholder?: string;
  newRealm?: 'personal' | 'work';
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PersonRef[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    const t = window.setTimeout(() => {
      api
        .listContacts({ q: term, allRealms: true })
        .then((list) => setResults(list.slice(0, 8).map((c) => ({ id: c.id, name: c.name }))))
        .catch(() => setResults([]));
    }, 180);
    return () => window.clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function pick(p: PersonRef) {
    if (value.some((v) => v.id === p.id)) return;
    onChange(multiple ? [...value, p] : [p]);
    setQ('');
    setResults([]);
    setOpen(false);
  }

  async function addNew() {
    const name = q.trim();
    if (!name) return;
    setBusy(true);
    try {
      const c = await api.createContact({ name, realm: newRealm });
      pick({ id: c.id, name: c.name });
    } finally {
      setBusy(false);
    }
  }

  const exact = results.some((r) => r.name.toLowerCase() === q.trim().toLowerCase());
  const showList = open && q.trim().length >= 2;

  return (
    <div className="contact-picker" ref={boxRef}>
      {value.length > 0 && (
        <div className="contact-picker__chips">
          {value.map((p) => (
            <span key={p.id} className="contact-picker__chip">
              {p.name}
              <button type="button" aria-label={`Remove ${p.name}`} onClick={() => onChange(value.filter((v) => v.id !== p.id))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {(multiple || value.length === 0) && (
        <input
          className="contact-picker__input"
          value={q}
          placeholder={placeholder}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (results[0]) pick(results[0]);
              else if (q.trim()) addNew();
            }
            if (e.key === 'Escape') setOpen(false);
          }}
        />
      )}
      {showList && (
        <div className="contact-picker__list">
          {results
            .filter((r) => !value.some((v) => v.id === r.id))
            .map((r) => (
              <button key={r.id} type="button" className="contact-picker__opt" onClick={() => pick(r)}>
                {r.name}
              </button>
            ))}
          {!exact && (
            <button type="button" className="contact-picker__opt contact-picker__opt--new" disabled={busy} onClick={addNew}>
              + Add “{q.trim()}” as a {newRealm === 'work' ? 'Work' : 'Personal'} contact
            </button>
          )}
        </div>
      )}
    </div>
  );
}

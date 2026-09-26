import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { ContactAskResponse, ContactCircle } from '../api/types';

const CIRCLE_LABELS: Record<ContactCircle, string> = {
  family: 'Family',
  friends: 'Friends',
  neighbors: 'Neighbors',
  community: 'Community',
  professional: 'Professional',
  other: 'Other',
};

const EXAMPLES = [
  'friends in Salem',
  'Republicans under 25 in Bedford',
  'neighbors over 65',
  'Democrats between 30 and 40',
];

/** The dedicated "Ask" panel Mike asked for — a rule-based (no AI/API calls
 * at runtime) natural-language query over contacts + voter data. See
 * worker/src/contactsAssistant.ts for exactly what it can parse; this panel
 * just renders whatever that endpoint understood. Kept as its own space
 * within Contacts rather than folded into the list/filter toolbar, per
 * Mike's own scoping choice. */
export function ContactsAskPanel({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<ContactAskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleAsk(q?: string) {
    const question = (q ?? query).trim();
    if (!question) return;
    setQuery(question);
    setAsking(true);
    setError(null);
    try {
      const r = await api.askContacts(question);
      setResult(r);
    } catch (e) {
      setError(String(e));
      setResult(null);
    } finally {
      setAsking(false);
    }
  }

  const nothingUnderstood = result && result.understood.length === 0;

  return (
    <div>
      <div className="toolbar-row">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
          Ask
        </h1>
        <button className="btn btn--ghost" onClick={onBack}>
          ← Back to list
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <input
          autoFocus
          placeholder='Ask about your contacts — e.g. "friends in Salem"'
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAsk()}
          style={{ flex: 1 }}
        />
        <button className="btn" onClick={() => handleAsk()} disabled={asking || !query.trim()}>
          {asking ? 'Asking…' : 'Ask'}
        </button>
      </div>

      {!result && !asking && (
        <div style={{ marginTop: 12 }}>
          <p className="text-muted" style={{ margin: '0 0 6px' }}>Try:</p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" className="chip" onClick={() => handleAsk(ex)}>
                {ex}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <div className="empty-state" style={{ marginTop: 12 }}>Couldn't run that: {error}</div>}

      {result && (
        <div style={{ marginTop: 16 }}>
          <p style={{ fontSize: 18, fontWeight: 600, margin: '0 0 8px' }}>{result.summary}</p>

          {result.understood.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              {result.understood.map((u) => (
                <span key={u} className="chip chip--accent">
                  {u}
                </span>
              ))}
            </div>
          )}

          {nothingUnderstood ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {EXAMPLES.map((ex) => (
                <button key={ex} type="button" className="chip" onClick={() => handleAsk(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          ) : (
            <div className="project-card-list">
              {result.contacts.map((c) => (
                <div key={c.id} className="card project-card" onClick={() => navigate(`/contacts/${c.id}`)}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <p className="project-card__title">
                      <span className="project-card__title-text">{c.name}</span>
                    </p>
                    <div className="project-card__stats">
                      <span>{CIRCLE_LABELS[c.circle]}</span>
                      {c.city && <span>{c.city}</span>}
                      {c.party && <span>{c.party}</span>}
                      {c.voterAge != null && <span>Age {c.voterAge}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

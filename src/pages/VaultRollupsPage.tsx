import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { VaultRollupGroup } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';

// A label used this many times or more graduates from "just a rollup" to
// a promoted filter chip up top — the threshold from the free-form-fields-
// vs-taxonomy discussion this was built from ("if the database sees a
// field name used more than 5 times..."). Below the threshold a label
// still rolls up here, it just isn't chip-worthy yet.
const PROMOTED_THRESHOLD = 5;

/** Rollups — every Quick Fact across the whole Vault, grouped by label
 * (case/whitespace-insensitive, not fuzzy — "Account #" and "Acct #" stay
 * separate groups). So a label used on several entries, like "Account #"
 * or "VIN", shows up as one list of every entry that has it. Single-use
 * labels are hidden by default since a group of one isn't really a
 * rollup — they're still there behind "Show all labels". Labels used 5+
 * times additionally get a filter chip up top — click one to narrow the
 * grid down to just that field. */
// A value "matches" the filter box either as raw text (case-insensitive
// substring — "amazon" against "Amazon.com") or, for an auto-detected date,
// against its normalized ISO form ("2026" against "2026-07-26") — so typing
// a year filters any date-like field (Purchase Date, Renewed On, whatever
// label it's under) without Mike having to know it's stored as a date at
// all. Currency isn't given the same treatment here since "matching a
// number" is ambiguous (amount vs. a substring of it); it still falls back
// to a plain text match on the displayed value.
function valueMatchesFilter(entry: { value: string | null; valueType?: 'date' | 'currency' | null; valueNorm?: string | null }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (entry.valueType === 'date' && entry.valueNorm && entry.valueNorm.toLowerCase().includes(q)) return true;
  return (entry.value ?? '').toLowerCase().includes(q);
}

export function VaultRollupsPage() {
  const [groups, setGroups] = useState<VaultRollupGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);
  const [valueQuery, setValueQuery] = useState('');

  useEffect(() => {
    api.getVaultRollup().then(setGroups).catch((e) => setError(String(e)));
  }, []);

  useReportTabMeta('Vault Rollups', 'vault-rollups');

  function copy(factId: string, value: string) {
    navigator.clipboard.writeText(value).then(() => {
      setCopiedId(factId);
      setTimeout(() => setCopiedId((id) => (id === factId ? null : id)), 1200);
    });
  }

  if (error) return <div className="empty-state">Couldn't load rollups: {error}</div>;
  if (!groups) return <div className="empty-state">Loading…</div>;

  const promoted = groups.filter((g) => g.count >= PROMOTED_THRESHOLD);
  const base = showAll ? groups : groups.filter((g) => g.count > 1);
  const labelFiltered = activeFilter ? base.filter((g) => g.label === activeFilter) : base;
  // Value filter applies within whatever's already shown, narrowing each
  // group's rows and dropping a group entirely once nothing in it matches
  // — e.g. typing "amazon" against the whole Vendor Page rollup leaves just
  // the entries actually bought there.
  const shown = valueQuery.trim()
    ? labelFiltered.map((g) => ({ ...g, entries: g.entries.filter((e) => valueMatchesFilter(e, valueQuery)) })).filter((g) => g.entries.length > 0)
    : labelFiltered;
  const hiddenCount = groups.length - base.length;

  return (
    <div>
      <div className="toolbar-row">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
          Vault Rollups
        </h1>
        <Link to="/vault" className="btn btn--ghost">
          ‹ Back to Vault
        </Link>
      </div>

      <div className="vault-rollup-value-filter">
        <input
          type="text"
          className="vault-rollup-value-filter__input"
          placeholder="Filter by value — e.g. “amazon” or a year like “2026”"
          value={valueQuery}
          onChange={(e) => setValueQuery(e.target.value)}
        />
        {valueQuery && (
          <button type="button" className="vault-rollup-value-filter__clear" onClick={() => setValueQuery('')} title="Clear">
            ✕
          </button>
        )}
      </div>

      {promoted.length > 0 && (
        <div className="vault-rollup-filters">
          <span className="vault-rollup-filters__label">Filters (used {PROMOTED_THRESHOLD}+ times)</span>
          <div className="vault-rollup-filters__chips">
            {promoted.map((g) => (
              <button
                key={g.label}
                type="button"
                className={`chip${activeFilter === g.label ? ' is-active' : ''}`}
                onClick={() => setActiveFilter((cur) => (cur === g.label ? null : g.label))}
              >
                {g.label} ({g.count})
              </button>
            ))}
          </div>
        </div>
      )}

      {shown.length === 0 ? (
        <div className="empty-state empty-state--section">
          {groups.length === 0
            ? 'No quick facts filed yet — add some to your Vault entries and they’ll roll up here.'
            : valueQuery.trim()
              ? `Nothing matches “${valueQuery.trim()}”.`
              : 'No label is used on more than one entry yet.'}
        </div>
      ) : (
        <div className="vault-rollup-grid">
          {shown.map((g) => (
            <div key={g.label} className="vault-rollup-card">
              <div className="vault-rollup-card__header">
                <span className="vault-rollup-card__label">{g.label}</span>
                <span className="vault-rollup-card__count">{valueQuery.trim() ? `${g.entries.length} of ${g.count}` : g.count}</span>
              </div>
              <div className="vault-rollup-card__rows">
                {g.entries.map((e) => (
                  <div key={e.factId} className="vault-rollup-card__row">
                    <Link to={`/vault/${e.entryId}`} className="vault-rollup-card__entry" title={e.entryTitle}>
                      {e.entryTitle}
                    </Link>
                    <span className="vault-rollup-card__value">
                      {e.value || <span className="vault-facts__value--empty">—</span>}
                    </span>
                    {e.value && (
                      <button
                        type="button"
                        className="vault-facts__copy"
                        onClick={() => copy(e.factId, e.value as string)}
                        title="Copy"
                      >
                        {copiedId === e.factId ? '✓' : '⧉'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {hiddenCount > 0 && !showAll && (
        <button type="button" className="vault-rollup-show-all" onClick={() => setShowAll(true)}>
          Show all labels (including {hiddenCount} used once)
        </button>
      )}
    </div>
  );
}

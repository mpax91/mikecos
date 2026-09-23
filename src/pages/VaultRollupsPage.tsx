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
export function VaultRollupsPage() {
  const [groups, setGroups] = useState<VaultRollupGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);

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
  const shown = activeFilter ? base.filter((g) => g.label === activeFilter) : base;
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
            : 'No label is used on more than one entry yet.'}
        </div>
      ) : (
        <div className="vault-rollup-grid">
          {shown.map((g) => (
            <div key={g.label} className="vault-rollup-card">
              <div className="vault-rollup-card__header">
                <span className="vault-rollup-card__label">{g.label}</span>
                <span className="vault-rollup-card__count">{g.count}</span>
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

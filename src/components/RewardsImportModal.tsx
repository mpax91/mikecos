import { useState } from 'react';
import { api } from '../api/client';
import type { RewardsImportResult } from '../api/types';
import { Modal } from './Modal';

/** The ingest side of the quarterly research workflow — see
 * worker/migrations/0057_rewards_import.sql and rewards.ts's /export and
 * /import endpoints. The research itself (what does each card actually
 * earn this quarter, with online/in-person split correctly per merchant)
 * happens in a separate Claude project Mike runs once a quarter, seeded
 * from "Export current cards" below; this modal is just where that
 * project's output JSON gets pasted or dropped back in. */
export function RewardsImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RewardsImportResult | null>(null);

  function onFile(file: File) {
    file.text().then(setText).catch((e) => setError(String(e)));
  }

  async function handleExport() {
    setBusy(true);
    setError(null);
    try {
      const data = await api.exportRewardsCards();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mikeos-rewards-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleImport() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const payload = JSON.parse(text);
      const cards = Array.isArray(payload) ? payload : payload.cards;
      const merchants = Array.isArray(payload) ? undefined : payload.merchants;
      if (!Array.isArray(cards) && !Array.isArray(merchants)) {
        throw new Error('Expected a top-level "cards" array, a "merchants" array, or both (or a bare array of cards).');
      }
      const res = await api.importRewardsCards({ cards, merchants });
      setResult(res);
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Quarterly Rewards Import" onClose={onClose}>
      <p className="settings-page__section-hint">
        Run the research in a separate Claude project once a quarter (start it from "Export current cards" so it
        knows what's already on file), then paste or drop the JSON it hands back here. Matching is by each card's
        import key — an existing card gets its rate/bonuses refreshed, a new key creates a card, and anything you
        added by hand yourself is never touched.
      </p>

      <div className="rewards-import__actions">
        <button type="button" className="btn btn--ghost" onClick={handleExport} disabled={busy}>
          Export current cards
        </button>
        <label className="btn btn--ghost rewards-import__file-btn">
          Choose file…
          <input
            type="file"
            accept="application/json"
            style={{ display: 'none' }}
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
        </label>
      </div>

      <textarea
        className="rewards-import__textarea"
        placeholder="Paste the import JSON here, or choose a file above…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
      />

      {error && <div className="settings-page__rrule-error">{error}</div>}

      {result && (
        <div className="rewards-import__result">
          <div>
            {result.created} card{result.created === 1 ? '' : 's'} created, {result.updated} updated, {result.bonusesWritten} bonus rows written
            {result.perksWritten > 0 ? `, ${result.perksWritten} perks written` : ''}
            {result.merchantsWritten > 0 ? `, ${result.merchantsWritten} merchants written` : ''}.
          </div>
          {result.errors.length > 0 && (
            <ul className="rewards-import__errors">
              {result.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          {result.unmatchedExisting.length > 0 && (
            <div className="rewards-import__unmatched">
              Not in this import (left as-is): {result.unmatchedExisting.map((c) => c.nickname).join(', ')}
            </div>
          )}
        </div>
      )}

      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose}>
          Close
        </button>
        <button className="btn" onClick={handleImport} disabled={!text.trim() || busy}>
          {busy ? 'Importing…' : 'Import'}
        </button>
      </div>
    </Modal>
  );
}

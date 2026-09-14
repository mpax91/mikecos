import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { ImportBatch, ImportDecision, ImportMatch, ImportPreviewResponse } from '../../api/types';
import { formatRelativeTime } from '../../utils/formatRelativeTime';

type Kind = 'contacts' | 'voter_file';

function UploadCard({
  kind,
  title,
  description,
  accept,
  onFile,
  busy,
}: {
  kind: Kind;
  title: string;
  description: string;
  accept: string;
  onFile: (file: File, kind: Kind) => void;
  busy: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="card contact-import__card">
      <h3 className="contact-import__card-title">{title}</h3>
      <p className="contact-import__card-desc">{description}</p>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file, kind);
          e.target.value = '';
        }}
      />
      <button type="button" className="btn" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? 'Processing…' : 'Upload File'}
      </button>
    </div>
  );
}

function ReviewRow({
  match,
  resolution,
  onResolve,
}: {
  match: ImportMatch;
  resolution: 'merge' | 'new' | undefined;
  onResolve: (choice: 'merge' | 'new') => void;
}) {
  return (
    <div className="contact-import__review-row">
      <div>
        <strong>{match.record.name}</strong>
        <span className="contact-import__review-hint"> matches existing contact "{match.existingName}"</span>
      </div>
      <div className="contact-import__review-actions">
        <button type="button" className={`chip${resolution === 'merge' ? ' is-active' : ''}`} onClick={() => onResolve('merge')}>
          Same person
        </button>
        <button type="button" className={`chip${resolution === 'new' ? ' is-active' : ''}`} onClick={() => onResolve('new')}>
          Different person
        </button>
      </div>
    </div>
  );
}

/** Contact & Voter File Import — Settings panel for bringing personal
 * contacts (Google's CSV export, or a vCard export from Apple/Samsung/
 * Outlook) and the Bedford voter roll (CSV) into MikeOS's Contacts.
 *
 * The core guarantee, and the reason this isn't a one-click "upload and
 * done" flow: nothing already in MikeOS is ever overwritten. A match
 * against an existing contact only fills in fields that were empty —
 * see POST /api/contacts/import/commit's additive-merge logic — and
 * anything the matcher isn't confident about (same name, no matching
 * email/phone) stops here for a one-click "same person or not" decision
 * rather than guessing. A voter file row with no match becomes its own
 * new contact, tagged so it stays out of the circles/reach-out system
 * meant for people Mike actually knows. */
export function ContactImportPanel() {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [resolutions, setResolutions] = useState<Map<number, 'merge' | 'new'>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [history, setHistory] = useState<ImportBatch[] | null>(null);

  function loadHistory() {
    api.listImportHistory().then(setHistory).catch(() => {});
  }

  useEffect(() => {
    loadHistory();
  }, []);

  async function handleFile(file: File, kind: Kind) {
    setError(null);
    setResult(null);
    setPreview(null);
    setResolutions(new Map());
    setBusy(true);
    try {
      const content = await file.text();
      const p = await api.previewContactImport(content, file.name, kind);
      setPreview(p);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function setResolution(index: number, choice: 'merge' | 'new') {
    setResolutions((prev) => {
      const next = new Map(prev);
      next.set(index, choice);
      return next;
    });
  }

  const reviewResolvedCount = preview ? preview.review.filter((_, i) => resolutions.has(i)).length : 0;
  const allReviewed = !!preview && reviewResolvedCount === preview.review.length;

  async function handleImport() {
    if (!preview || !allReviewed) return;
    setBusy(true);
    setError(null);
    try {
      const decisions: ImportDecision[] = [
        ...preview.auto.map((m) => ({ record: m.record, action: 'merge' as const, contactId: m.existingContactId })),
        ...preview.fresh.map((m) => ({ record: m.record, action: 'new' as const })),
        ...preview.review.map((m, i) => {
          const choice = resolutions.get(i);
          return choice === 'merge'
            ? { record: m.record, action: 'merge' as const, contactId: m.existingContactId }
            : { record: m.record, action: 'new' as const };
        }),
      ];
      const res = await api.commitContactImport(preview.kind, preview.filename, decisions);
      setResult(`Imported "${preview.filename}" — ${res.newCount} new, ${res.updatedCount} updated.`);
      setPreview(null);
      setResolutions(new Map());
      loadHistory();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 className="settings-page__section-title">Contact & Voter File Import</h2>
      <p className="settings-page__section-hint">
        Upload a contacts export or the Bedford voter roll to update Contacts. Matching only ever fills in what's
        missing — nothing already in MikeOS gets overwritten, and anything ambiguous stops for you to confirm before
        anything is written.
      </p>

      <div className="contact-import__cards">
        <UploadCard
          kind="contacts"
          title="Personal Contacts"
          description="A Google Contacts CSV export, or a vCard (.vcf) export from Apple, Samsung, or Outlook."
          accept=".csv,.vcf,text/csv,text/vcard"
          onFile={handleFile}
          busy={busy}
        />
        <UploadCard
          kind="voter_file"
          title="Bedford Voter File"
          description="A CSV of registered voters. Unmatched rows become new contacts, kept separate from your personal circles."
          accept=".csv,text/csv"
          onFile={handleFile}
          busy={busy}
        />
      </div>

      {error && <div className="contact-import__error">{error}</div>}
      {result && <div className="contact-import__result">{result}</div>}

      {preview && (
        <div className="contact-import__preview">
          <div className="contact-import__preview-summary">
            <span>{preview.totalRows} rows in "{preview.filename}"</span>
            <span>{preview.auto.length} will update existing contacts</span>
            <span>{preview.fresh.length} are new</span>
            {preview.review.length > 0 && <span>{preview.review.length} need your review</span>}
          </div>

          {preview.review.length > 0 && (
            <div className="contact-import__review-list">
              {preview.review.map((m, i) => (
                <ReviewRow key={i} match={m} resolution={resolutions.get(i)} onResolve={(choice) => setResolution(i, choice)} />
              ))}
            </div>
          )}

          <div className="modal__actions" style={{ marginTop: 12 }}>
            <button className="btn btn--ghost" onClick={() => setPreview(null)}>
              Cancel
            </button>
            <button className="btn" onClick={handleImport} disabled={!allReviewed || busy}>
              {allReviewed ? 'Import' : `Resolve ${preview.review.length - reviewResolvedCount} more`}
            </button>
          </div>
        </div>
      )}

      {history && history.length > 0 && (
        <div className="contact-import__history">
          <h3 className="contact-import__card-title">Import History</h3>
          {history.map((h) => (
            <div key={h.id} className="contact-import__history-row">
              <span>{h.filename}</span>
              <span className="contact-import__review-hint">
                {h.kind === 'voter_file' ? 'Voter file' : 'Contacts'} · {h.new_count} new · {h.updated_count} updated
              </span>
              <span className="last-modified-badge">{formatRelativeTime(h.created_at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { DuplicateCandidate, ImportBatch, ImportDecision, ImportMatch, ImportPreviewResponse, OrphanedImportsResponse, VoterNamesPreviewResponse } from '../../api/types';
import { formatRelativeTime } from '../../utils/formatRelativeTime';

type Kind = 'contacts' | 'voter_file';

// Each chunk rides in its own request so one huge file (the 12k-row Bedford
// voter roll, in production) never sits in a single request long enough to
// get killed partway through — see api.commitContactImportChunk's comment.
const CHUNK_SIZE = 150;

// Same reasoning as CHUNK_SIZE above, applied to the voter-name bulk
// cleanup instead of a fresh import.
const NAME_CLEANUP_CHUNK_SIZE = 200;

// How many duplicate-candidate rows to render before "show all" — the
// scanner can surface a lot of pairs, and there's no need to paint them
// all at once when the list is going to shrink as Mike merges through it.
const DUPLICATES_INITIAL_SHOW = 25;

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

/** One duplicate-candidate row — a personal contact matched against one or
 * more standalone voter-roll contacts sharing its name. `voters.length` is
 * almost always 1 (one Merge button); when it's more than one (two
 * different voter-roll people whose names happen to reduce to the same
 * key), each gets its own button since only Mike can tell which — if
 * either — is really the same person. */
function DuplicateRow({
  candidate,
  onMerge,
  mergingVoterId,
}: {
  candidate: DuplicateCandidate;
  onMerge: (voterId: string) => void;
  mergingVoterId: string | null;
}) {
  return (
    <div className="contact-import__review-row">
      <div>
        <strong>{candidate.personal.name}</strong>
        <span className="contact-import__review-hint"> ({circleLabelFor(candidate.personal.circle)}) — matches the voter roll</span>
      </div>
      <div className="contact-import__review-actions">
        {candidate.voters.map((v) => (
          <button
            key={v.id}
            type="button"
            className="chip"
            onClick={() => onMerge(v.id)}
            disabled={mergingVoterId === v.id}
            title={`Merge "${v.name}" into "${candidate.personal.name}"`}
          >
            {mergingVoterId === v.id ? 'Merging…' : `Merge "${v.name}"`}
          </button>
        ))}
      </div>
    </div>
  );
}

const CIRCLE_LABELS: Record<string, string> = {
  family: 'Family',
  friends: 'Friends',
  neighbors: 'Neighbors',
  community: 'Community',
  professional: 'Professional',
  other: 'Other',
};

function circleLabelFor(circle: string): string {
  return CIRCLE_LABELS[circle] ?? 'Other';
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
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [orphaned, setOrphaned] = useState<OrphanedImportsResponse | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [undoingBatchId, setUndoingBatchId] = useState<string | null>(null);
  const [confirmingUndoId, setConfirmingUndoId] = useState<string | null>(null);
  const [nameCleanup, setNameCleanup] = useState<VoterNamesPreviewResponse | null>(null);
  const [confirmingNameCleanup, setConfirmingNameCleanup] = useState(false);
  const [nameCleanupProgress, setNameCleanupProgress] = useState<{ done: number; total: number } | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[] | null>(null);
  const [mergingVoterId, setMergingVoterId] = useState<string | null>(null);
  const [showAllDuplicates, setShowAllDuplicates] = useState(false);

  function loadHistory() {
    api.listImportHistory().then(setHistory).catch(() => {});
  }

  function loadOrphaned() {
    api.getOrphanedImports().then(setOrphaned).catch(() => {});
  }

  function loadNameCleanup() {
    api.previewVoterNameCleanup().then(setNameCleanup).catch(() => {});
  }

  function loadDuplicates() {
    api
      .listDuplicateCandidates()
      .then((r) => setDuplicates(r.candidates))
      .catch(() => {});
  }

  useEffect(() => {
    loadHistory();
    loadOrphaned();
    loadNameCleanup();
    loadDuplicates();
  }, []);

  async function handleMergeDuplicate(personalId: string, voterId: string) {
    setMergingVoterId(voterId);
    setError(null);
    try {
      await api.mergeContact(personalId, voterId);
      // Optimistic: drop just this voter from its candidate (or the whole
      // candidate if that was its only match) rather than re-fetching the
      // whole scan, which can be a few hundred rows on a full contact list.
      setDuplicates((prev) =>
        prev
          ? prev
              .map((cand) => (cand.personal.id === personalId ? { ...cand, voters: cand.voters.filter((v) => v.id !== voterId) } : cand))
              .filter((cand) => cand.voters.length > 0)
          : prev
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setMergingVoterId(null);
    }
  }

  async function handleCleanupVoterNames() {
    if (!nameCleanup) return;
    setError(null);
    setNameCleanupProgress({ done: 0, total: nameCleanup.totalVoterContacts });
    try {
      let offset = 0;
      let totalUpdated = 0;
      // Loop the chunked endpoint until it says done, same pattern as the
      // chunked import commit — bounded requests instead of one that could
      // run long enough on ~12k rows to hit the same limit that motivated
      // that fix in the first place.
      while (true) {
        const res = await api.cleanupVoterNamesChunk(offset, NAME_CLEANUP_CHUNK_SIZE);
        totalUpdated += res.updated;
        offset = res.nextOffset;
        setNameCleanupProgress({ done: offset, total: nameCleanup.totalVoterContacts });
        if (res.done) break;
      }
      setResult(`Cleaned up ${totalUpdated.toLocaleString()} voter-roll name${totalUpdated === 1 ? '' : 's'} — honorifics and middle initials dropped, Title Case applied.`);
      setConfirmingNameCleanup(false);
      loadNameCleanup();
    } catch (e) {
      setError(String(e));
    } finally {
      setNameCleanupProgress(null);
    }
  }

  async function handleClearOrphaned() {
    setClearing(true);
    setError(null);
    try {
      const res = await api.clearOrphanedImports();
      setResult(`Removed ${res.deletedCount} leftover contact${res.deletedCount === 1 ? '' : 's'} from an incomplete import.`);
      setConfirmingClear(false);
      loadOrphaned();
    } catch (e) {
      setError(String(e));
    } finally {
      setClearing(false);
    }
  }

  async function handleUndoBatch(batch: ImportBatch) {
    setUndoingBatchId(batch.id);
    setError(null);
    try {
      const res = await api.deleteImportBatch(batch.id);
      setResult(`Undid "${batch.filename}" — removed ${res.deletedCount.toLocaleString()} contact${res.deletedCount === 1 ? '' : 's'} it created. Safe to re-upload the file now.`);
      setConfirmingUndoId(null);
      loadHistory();
      loadOrphaned();
    } catch (e) {
      setError(String(e));
    } finally {
      setUndoingBatchId(null);
    }
  }

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
    setProgress(null);
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

      const { batchId } = await api.startContactImportCommit(preview.kind, preview.filename, decisions.length);

      let newCount = 0;
      let updatedCount = 0;
      setProgress({ done: 0, total: decisions.length });
      for (let i = 0; i < decisions.length; i += CHUNK_SIZE) {
        const chunk = decisions.slice(i, i + CHUNK_SIZE);
        const res = await api.commitContactImportChunk(batchId, preview.kind, chunk);
        newCount += res.newCount;
        updatedCount += res.updatedCount;
        setProgress({ done: Math.min(i + chunk.length, decisions.length), total: decisions.length });
      }

      await api.finishContactImportCommit(batchId);

      setResult(`Imported "${preview.filename}" — ${newCount} new, ${updatedCount} updated.`);
      setPreview(null);
      setResolutions(new Map());
      loadHistory();
      loadOrphaned();
    } catch (e) {
      setError(
        `${String(e)} — the import may be incomplete. Check Import History below; if it shows "Incomplete", ` +
          `it's safe to re-upload the same file (already-imported rows will just be matched and skipped or merged).`
      );
      loadHistory();
      loadOrphaned();
    } finally {
      setBusy(false);
      setProgress(null);
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

          {progress && (
            <div className="contact-import__progress">
              <div className="contact-import__progress-bar">
                <div
                  className="contact-import__progress-fill"
                  style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }}
                />
              </div>
              <span className="contact-import__review-hint">
                Importing… {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
              </span>
            </div>
          )}

          <div className="modal__actions" style={{ marginTop: 12 }}>
            <button className="btn btn--ghost" onClick={() => setPreview(null)} disabled={busy}>
              Cancel
            </button>
            <button className="btn" onClick={handleImport} disabled={!allReviewed || busy}>
              {busy ? 'Importing…' : allReviewed ? 'Import' : `Resolve ${preview.review.length - reviewResolvedCount} more`}
            </button>
          </div>
        </div>
      )}

      {orphaned && orphaned.count > 0 && (
        <div className="contact-import__orphaned">
          <h3 className="contact-import__card-title">Incomplete Import Found</h3>
          <p className="contact-import__card-desc">
            {orphaned.count.toLocaleString()} contact{orphaned.count === 1 ? '' : 's'} were left behind by an import
            that didn't finish{orphaned.sample.length > 0 ? ` (e.g. "${orphaned.sample[0].name}")` : ''}. It's safe to
            remove these and re-upload the file — nothing else in your Contacts is affected.
          </p>
          {!confirmingClear ? (
            <button type="button" className="btn btn--ghost" onClick={() => setConfirmingClear(true)}>
              Clear Incomplete Import
            </button>
          ) : (
            <div className="modal__actions">
              <button type="button" className="btn btn--ghost" onClick={() => setConfirmingClear(false)} disabled={clearing}>
                Never mind
              </button>
              <button type="button" className="btn btn--danger" onClick={handleClearOrphaned} disabled={clearing}>
                {clearing ? 'Removing…' : `Remove ${orphaned.count.toLocaleString()} contact${orphaned.count === 1 ? '' : 's'}`}
              </button>
            </div>
          )}
        </div>
      )}

      {nameCleanup && nameCleanup.changeCount > 0 && (
        <div className="contact-import__orphaned">
          <h3 className="contact-import__card-title">Voter Roll Names Need Cleanup</h3>
          <p className="contact-import__card-desc">
            {nameCleanup.changeCount.toLocaleString()} of your {nameCleanup.totalVoterContacts.toLocaleString()} voter-roll
            contacts still have their raw import name — honorifics and middle initials included, all caps
            {nameCleanup.sample.length > 0 && (
              <>
                {' '}(e.g. "{nameCleanup.sample[0].before}" → "{nameCleanup.sample[0].after}")
              </>
            )}
            . This just renames them — nothing is merged or deleted.
          </p>
          {nameCleanupProgress ? (
            <div className="contact-import__progress">
              <div className="contact-import__progress-bar">
                <div
                  className="contact-import__progress-fill"
                  style={{ width: `${nameCleanupProgress.total ? Math.round((nameCleanupProgress.done / nameCleanupProgress.total) * 100) : 0}%` }}
                />
              </div>
              <span className="contact-import__review-hint">
                Cleaning up… {nameCleanupProgress.done.toLocaleString()} / {nameCleanupProgress.total.toLocaleString()}
              </span>
            </div>
          ) : !confirmingNameCleanup ? (
            <button type="button" className="btn btn--ghost" onClick={() => setConfirmingNameCleanup(true)}>
              Clean Up Voter Names
            </button>
          ) : (
            <div className="modal__actions">
              <button type="button" className="btn btn--ghost" onClick={() => setConfirmingNameCleanup(false)}>
                Never mind
              </button>
              <button type="button" className="btn" onClick={handleCleanupVoterNames}>
                Clean Up {nameCleanup.changeCount.toLocaleString()} Name{nameCleanup.changeCount === 1 ? '' : 's'}
              </button>
            </div>
          )}
        </div>
      )}

      {duplicates && duplicates.length > 0 && (
        <div className="contact-import__orphaned">
          <h3 className="contact-import__card-title">Possible Duplicates</h3>
          <p className="contact-import__card-desc">
            {duplicates.length.toLocaleString()} contact{duplicates.length === 1 ? '' : 's'} in your circles {duplicates.length === 1 ? 'has a' : 'have'} a
            matching name on the voter roll. Merge the ones that are really the same person — this never overwrites what you already
            have, it only fills in blanks.
          </p>
          {(showAllDuplicates ? duplicates : duplicates.slice(0, DUPLICATES_INITIAL_SHOW)).map((c) => (
            <DuplicateRow key={c.personal.id} candidate={c} onMerge={(voterId) => handleMergeDuplicate(c.personal.id, voterId)} mergingVoterId={mergingVoterId} />
          ))}
          {duplicates.length > DUPLICATES_INITIAL_SHOW && (
            <button type="button" className="btn btn--ghost" onClick={() => setShowAllDuplicates((v) => !v)}>
              {showAllDuplicates ? 'Show fewer' : `Show all ${duplicates.length.toLocaleString()}`}
            </button>
          )}
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
                {h.total_rows != null ? ` of ${h.total_rows.toLocaleString()}` : ''}
              </span>
              {h.status === 'in_progress' ? (
                <span className="chip contact-import__status-badge">Incomplete</span>
              ) : (
                <span className="last-modified-badge">{formatRelativeTime(h.created_at)}</span>
              )}
              {confirmingUndoId === h.id ? (
                <span className="contact-import__undo-confirm">
                  <span className="contact-import__review-hint">Remove the {h.new_count} contact{h.new_count === 1 ? '' : 's'} this created?</span>
                  <button type="button" className="btn btn--ghost" onClick={() => setConfirmingUndoId(null)} disabled={undoingBatchId === h.id}>
                    Never mind
                  </button>
                  <button type="button" className="btn btn--danger" onClick={() => handleUndoBatch(h)} disabled={undoingBatchId === h.id}>
                    {undoingBatchId === h.id ? 'Undoing…' : 'Undo Import'}
                  </button>
                </span>
              ) : (
                h.new_count > 0 && (
                  <button type="button" className="contact-import__undo-trigger" onClick={() => setConfirmingUndoId(h.id)}>
                    Undo
                  </button>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

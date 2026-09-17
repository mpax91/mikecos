import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { HealthParsePreview, HealthWeeklyReport } from '../../api/types';
import { extractPdfText } from '../../utils/pdfText';

interface PreviewRow extends HealthParsePreview {
  key: string; // filename + index, for React keys when the same file is picked twice
}

function formatWeekRange(start: string, end: string): string {
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(s)} – ${fmt(e)}`;
}

/** Health Import — Settings panel for bringing Google Health's weekly
 * progress-report emails (saved as PDF) into the Health dashboard. Narrow
 * by design for now (Google Health only, per Mike's own call when we
 * scoped this) — see the Health dashboard's own notes for why a general
 * multi-format importer is a later step, not this one.
 *
 * Same preview-before-commit shape as ContactImportPanel: extract text
 * client-side, send it to the worker for a read-only parse, show what it
 * found (including "this will update an existing week"), then commit only
 * once Mike confirms. Re-uploading an already-imported week is expected
 * and safe — it just overwrites that week's row with the same values. */
export function HealthImportPanel() {
  const [previews, setPreviews] = useState<PreviewRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HealthWeeklyReport[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function loadHistory() {
    api
      .listHealthWeekly()
      .then((rows) => setHistory([...rows].sort((a, b) => (a.week_start < b.week_start ? 1 : -1))))
      .catch(() => {});
  }

  useEffect(() => {
    loadHistory();
  }, []);

  // Need the raw extracted text again at commit time (the preview response
  // doesn't carry it back) — kept alongside each preview by the same key
  // rather than re-extracting, so a file picked twice or with a repeated
  // name never gets mixed up with another preview row.
  const [pendingFiles, setPendingFiles] = useState<Map<string, File>>(new Map());
  const keyCounter = useRef(0);

  async function handlePick(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const next: PreviewRow[] = [];
      const newPending = new Map<string, File>();
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const key = `${file.name}-${keyCounter.current++}`;
        newPending.set(key, file);
        try {
          const text = await extractPdfText(file);
          const preview = await api.previewHealthImport(file.name, text);
          next.push({ ...preview, key });
        } catch (e) {
          next.push({ filename: file.name, week: null, error: String(e), existing: null, key });
        }
      }
      // Newer weeks first, unparseable files last.
      next.sort((a, b) => (b.week?.week_start ?? '').localeCompare(a.week?.week_start ?? ''));
      setPreviews((prev) => [...next, ...prev]);
      setPendingFiles((prev) => new Map([...prev, ...newPending]));
    } finally {
      setBusy(false);
    }
  }

  function removePreview(key: string) {
    setPreviews((prev) => prev.filter((p) => p.key !== key));
    setPendingFiles((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }

  async function handleCommit() {
    const good = previews.filter((p) => p.week);
    if (good.length === 0) return;
    setCommitting(true);
    setError(null);
    try {
      const imports: { filename: string; text: string }[] = [];
      for (const p of good) {
        const file = pendingFiles.get(p.key);
        if (!file) continue;
        const text = await extractPdfText(file);
        imports.push({ filename: p.filename, text });
      }
      const res = await api.commitHealthImport(imports);
      const weekLabel = res.imported === 1 ? 'week' : 'weeks';
      setResult(`Imported ${res.imported} ${weekLabel}${res.errors.length ? ` — ${res.errors.length} failed` : ''}.`);
      if (res.errors.length) setError(res.errors.map((e) => `${e.filename}: ${e.error}`).join(' · '));
      setPreviews([]);
      setPendingFiles(new Map());
      loadHistory();
    } catch (e) {
      setError(String(e));
    } finally {
      setCommitting(false);
    }
  }

  const goodCount = previews.filter((p) => p.week).length;
  const errorCount = previews.length - goodCount;

  return (
    <div>
      <h2 className="settings-page__section-title">Health Import</h2>
      <p className="settings-page__section-hint">
        Upload your Google Health weekly progress-report emails, saved as PDF. Each covers one week — upload as many
        as you have, in any order or combination; re-uploading a week you've already imported is fine, it just
        refreshes that week's numbers.
      </p>

      <div className="card contact-import__card">
        <h3 className="contact-import__card-title">Weekly Progress Reports</h3>
        <p className="contact-import__card-desc">
          From Gmail: open the "Your weekly progress report from Google Health" email → Print → Save as PDF.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,application/pdf"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            handlePick(e.target.files);
            e.target.value = '';
          }}
        />
        <button type="button" className="btn" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? 'Reading…' : 'Upload PDFs'}
        </button>
      </div>

      {error && <div className="contact-import__error">{error}</div>}
      {result && <div className="contact-import__result">{result}</div>}

      {previews.length > 0 && (
        <div className="contact-import__preview">
          <div className="contact-import__preview-summary">
            <span>{previews.length} file{previews.length === 1 ? '' : 's'} read</span>
            <span>{goodCount} recognized</span>
            {errorCount > 0 && <span>{errorCount} couldn't be read</span>}
          </div>

          <div className="contact-import__review-list">
            {previews.map((p) => (
              <div key={p.key} className="contact-import__review-row">
                <div>
                  {p.week ? (
                    <>
                      <strong>{formatWeekRange(p.week.week_start, p.week.week_end)}</strong>
                      <span className="contact-import__review-hint">
                        {' '}
                        {p.week.total_steps?.toLocaleString() ?? '—'} steps
                        {p.existing ? ' — will update the week already on file' : ' — new week'}
                      </span>
                    </>
                  ) : (
                    <>
                      <strong>{p.filename}</strong>
                      <span className="contact-import__review-hint"> — {p.error}</span>
                    </>
                  )}
                </div>
                <div className="contact-import__review-actions">
                  <button type="button" className="chip" onClick={() => removePreview(p.key)}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="modal__actions" style={{ marginTop: 12 }}>
            <button className="btn btn--ghost" onClick={() => { setPreviews([]); setPendingFiles(new Map()); }} disabled={committing}>
              Cancel
            </button>
            <button className="btn" onClick={handleCommit} disabled={goodCount === 0 || committing}>
              {committing ? 'Importing…' : `Import ${goodCount} Week${goodCount === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}

      {history && history.length > 0 && (
        <div className="contact-import__history">
          <h3 className="contact-import__card-title">Imported Weeks</h3>
          {history.slice(0, 12).map((h) => (
            <div key={h.week_start} className="contact-import__history-row">
              <span>{formatWeekRange(h.week_start, h.week_end)}</span>
              <span className="contact-import__review-hint">
                {h.total_steps?.toLocaleString() ?? '—'} steps
                {h.avg_resting_heart_rate ? ` · ${h.avg_resting_heart_rate} bpm` : ''}
                {h.avg_weight_lb ? ` · ${h.avg_weight_lb}lb` : ''}
              </span>
            </div>
          ))}
          {history.length > 12 && (
            <p className="settings-page__section-hint" style={{ marginTop: 8 }}>
              +{history.length - 12} more — see the full history on the Dashboard.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

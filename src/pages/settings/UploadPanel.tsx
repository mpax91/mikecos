import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { HealthParsePreview, HealthWeeklyReport } from '../../api/types';
import { extractPdfText } from '../../utils/pdfText';

// ---------------------------------------------------------------------
// Recognizers — the plug-in point for "drop any document, we figure out
// what it is." Each one owns its own file-type sniff, its own preview
// call, and its own commit call; the panel below just tries each in turn
// and renders whichever one claims the file. Today there's exactly one
// (Google Health's weekly report PDF) — adding the next (a bank/investment
// statement, a BMW export, whatever's next) means adding another entry
// here, not rebuilding this screen.
// ---------------------------------------------------------------------

interface RecognizedFile {
  recognizerId: 'google-health';
  summary: string; // one line shown in the review list, e.g. "Sep 5 – Sep 11 · 58,156 steps"
  detail: string; // secondary hint, e.g. "will update the week already on file"
  commitPayload: { filename: string; text: string };
}

interface UnrecognizedFile {
  recognizerId: null;
  reason: string;
}

type FileOutcome = RecognizedFile | UnrecognizedFile;

async function tryGoogleHealth(file: File): Promise<FileOutcome> {
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!isPdf) return { recognizerId: null, reason: "Not a PDF — the only file type we know how to read so far is a Google Health weekly report." };
  let preview: HealthParsePreview;
  try {
    const text = await extractPdfText(file);
    preview = await api.previewHealthImport(file.name, text);
    if (!preview.week) return { recognizerId: null, reason: preview.error ?? "Couldn't recognize this PDF as a Google Health weekly report." };
    const range = formatWeekRange(preview.week.week_start, preview.week.week_end);
    return {
      recognizerId: 'google-health',
      summary: `${range} · ${preview.week.total_steps?.toLocaleString() ?? '—'} steps`,
      detail: preview.existing ? 'will update the week already on file' : 'new week',
      commitPayload: { filename: file.name, text },
    };
  } catch (e) {
    return { recognizerId: null, reason: String(e) };
  }
}

// Every recognizer gets a turn, in order, until one claims the file. With
// only one registered, this just runs it and reports why it didn't match
// when it doesn't — but it's already shaped for a second and third entry.
async function recognize(file: File): Promise<FileOutcome> {
  return tryGoogleHealth(file);
}

function formatWeekRange(start: string, end: string): string {
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(s)} – ${fmt(e)}`;
}

interface Row {
  key: string;
  filename: string;
  outcome: FileOutcome;
}

/** Upload — the one place any document gets dropped, and the default
 * screen when Settings opens (per Mike's own framing: "one upload box that
 * we wire to be able to recognize and properly import a variety of things
 * seamlessly"). Contact/voter-file import stays as its own tab since that
 * flow is a multi-step reconciliation (match, review, merge) rather than a
 * straight "read it and store it" import — everything else lands here. */
export function UploadPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HealthWeeklyReport[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const keyCounter = useRef(0);

  function loadHistory() {
    api
      .listHealthWeekly()
      .then((weeks) => setHistory([...weeks].sort((a, b) => (a.week_start < b.week_start ? 1 : -1))))
      .catch(() => {});
  }

  useEffect(() => {
    loadHistory();
  }, []);

  async function handlePick(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const next: Row[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const key = `${file.name}-${keyCounter.current++}`;
        const outcome = await recognize(file);
        next.push({ key, filename: file.name, outcome });
      }
      setRows((prev) => [...next, ...prev]);
    } finally {
      setBusy(false);
    }
  }

  function removeRow(key: string) {
    setRows((prev) => prev.filter((r) => r.key !== key));
  }

  const recognized = rows.filter((r) => r.outcome.recognizerId !== null) as (Row & { outcome: RecognizedFile })[];
  const unrecognizedCount = rows.length - recognized.length;

  async function handleCommit() {
    if (recognized.length === 0) return;
    setCommitting(true);
    setError(null);
    try {
      // Grouped by recognizer so each importer's own commit endpoint gets
      // called once with everything it claimed — right now that's just
      // google-health, but a second recognizer would get its own group
      // and its own api call here without touching anything else.
      const healthImports = recognized.filter((r) => r.outcome.recognizerId === 'google-health').map((r) => r.outcome.commitPayload);
      let imported = 0;
      const errors: { filename: string; error: string }[] = [];
      if (healthImports.length > 0) {
        const res = await api.commitHealthImport(healthImports);
        imported += res.imported;
        errors.push(...res.errors);
      }
      setResult(`Imported ${imported} item${imported === 1 ? '' : 's'}${errors.length ? ` — ${errors.length} failed` : ''}.`);
      if (errors.length) setError(errors.map((e) => `${e.filename}: ${e.error}`).join(' · '));
      setRows((prev) => prev.filter((r) => r.outcome.recognizerId === null)); // keep unrecognized rows visible, clear the committed ones
      loadHistory();
    } catch (e) {
      setError(String(e));
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div>
      <h2 className="settings-page__section-title">Upload</h2>
      <p className="settings-page__section-hint">
        Drop in a document and we'll figure out what it is — right now that's Google Health's weekly progress-report
        emails (saved as PDF from Gmail). More types land here over time: bank and investment statements, a car's
        export, anything else worth pulling into MikeOS.
      </p>

      <div className="card contact-import__card">
        <h3 className="contact-import__card-title">Any Document</h3>
        <p className="contact-import__card-desc">
          Currently recognized: Google Health weekly progress reports (PDF). From Gmail: open the email → Print →
          Save as PDF.
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            handlePick(e.target.files);
            e.target.value = '';
          }}
        />
        <button type="button" className="btn" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? 'Reading…' : 'Upload Files'}
        </button>
      </div>

      {error && <div className="contact-import__error">{error}</div>}
      {result && <div className="contact-import__result">{result}</div>}

      {rows.length > 0 && (
        <div className="contact-import__preview">
          <div className="contact-import__preview-summary">
            <span>{rows.length} file{rows.length === 1 ? '' : 's'} read</span>
            <span>{recognized.length} recognized</span>
            {unrecognizedCount > 0 && <span>{unrecognizedCount} not recognized</span>}
          </div>

          <div className="contact-import__review-list">
            {rows.map((r) => (
              <div key={r.key} className="contact-import__review-row">
                <div>
                  {r.outcome.recognizerId ? (
                    <>
                      <strong>{r.outcome.summary}</strong>
                      <span className="contact-import__review-hint"> — {r.outcome.detail}</span>
                    </>
                  ) : (
                    <>
                      <strong>{r.filename}</strong>
                      <span className="contact-import__review-hint"> — {r.outcome.reason}</span>
                    </>
                  )}
                </div>
                <div className="contact-import__review-actions">
                  <button type="button" className="chip" onClick={() => removeRow(r.key)}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>

          {recognized.length > 0 && (
            <div className="modal__actions" style={{ marginTop: 12 }}>
              <button className="btn btn--ghost" onClick={() => setRows((prev) => prev.filter((r) => r.outcome.recognizerId === null))} disabled={committing}>
                Clear recognized
              </button>
              <button className="btn" onClick={handleCommit} disabled={committing}>
                {committing ? 'Importing…' : `Import ${recognized.length} Item${recognized.length === 1 ? '' : 's'}`}
              </button>
            </div>
          )}
        </div>
      )}

      {history && history.length > 0 && (
        <div className="contact-import__history">
          <h3 className="contact-import__card-title">Health — Imported Weeks</h3>
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

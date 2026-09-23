import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type { CreditScoreEntry } from '../api/types';
import { buildCreditScoreSummary, fmtPts, fmtSigned, monthYear, type CreditScorePoint } from '../utils/creditScore';
import { ConfirmModal } from './ConfirmModal';

function todayLocalISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** A plain stat tile — same visual language as the Fitness dashboard's
 * Tile, kept as its own tiny copy here rather than importing that
 * module-local component, so this file stays a self-contained widget. */
function StatTile({ label, value, aside, delta, highlight }: { label: string; value: string | null; aside?: string | null; delta?: React.ReactNode; highlight?: 'high' | 'low' }) {
  return (
    <div className={`dashboard-page__tile card${highlight ? ' is-active' : ''}`}>
      <div className="dashboard-page__tile-label">{label}</div>
      <div className="dashboard-page__tile-value">{value ?? <span className="dashboard-page__tile-nodata">No data</span>}</div>
      {aside && <div className="dashboard-page__tile-aside">{aside}</div>}
      {delta && <div className="dashboard-page__tile-footer">{delta}</div>}
    </div>
  );
}

/** The trend line itself — 15+ years of monthly average scores. Points are
 * spaced by index (not literal calendar time) same as this app's other
 * hand-rolled charts (Sparkline, EquityChart), which is fine here since
 * entries land ~monthly with no real gaps. A hover crosshair + tooltip
 * (per dataviz's "a line chart is interactive by default") lets Mike read
 * any single month's exact score without cluttering the chart with labels
 * on every point; the all-time high/low and latest month get their own
 * small marker so those three moments are visible even without hovering. */
function CreditTrendChart({ series, allTimeHigh, allTimeLow }: { series: CreditScorePoint[]; allTimeHigh: CreditScorePoint | null; allTimeLow: CreditScorePoint | null }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const w = 600;
  const h = 200;
  const padTop = 10;
  const padBottom = 10;

  const values = series.map((p) => p.average);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = series.length > 1 ? w / (series.length - 1) : 0;

  const yOf = (v: number) => padTop + (1 - (v - min) / range) * (h - padTop - padBottom);
  const coords = series.map((p, i) => [i * step, yOf(p.average)] as const);
  const linePoints = coords.map(([x, y]) => `${x},${y}`).join(' ');
  const areaPoints = `0,${h} ${linePoints} ${w},${h}`;

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const idx = Math.round(fraction * (series.length - 1));
    setHoverIndex(idx);
  }

  const highIndex = allTimeHigh ? series.findIndex((p) => p.date === allTimeHigh.date) : -1;
  const lowIndex = allTimeLow ? series.findIndex((p) => p.date === allTimeLow.date) : -1;
  const latestIndex = series.length - 1;

  const hover = hoverIndex != null ? series[hoverIndex] : null;
  const hoverLeftPct = hoverIndex != null && series.length > 1 ? (hoverIndex / (series.length - 1)) * 100 : null;

  return (
    <div className="credit-trend" ref={wrapRef}>
      <svg
        className="credit-trend__chart"
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <line x1="0" y1={yOf(min)} x2={w} y2={yOf(min)} className="credit-trend__gridline" />
        <line x1="0" y1={yOf(max)} x2={w} y2={yOf(max)} className="credit-trend__gridline" />
        <polygon points={areaPoints} className="credit-trend__area" />
        <polyline points={linePoints} className="credit-trend__line" />
        {hoverIndex != null && <line x1={coords[hoverIndex][0]} y1="0" x2={coords[hoverIndex][0]} y2={h} className="credit-trend__crosshair" />}
        {lowIndex >= 0 && <circle cx={coords[lowIndex][0]} cy={coords[lowIndex][1]} r="4" className="credit-trend__dot credit-trend__dot--low" />}
        {highIndex >= 0 && <circle cx={coords[highIndex][0]} cy={coords[highIndex][1]} r="4" className="credit-trend__dot credit-trend__dot--high" />}
        <circle cx={coords[latestIndex][0]} cy={coords[latestIndex][1]} r="4.5" className="credit-trend__dot credit-trend__dot--latest" />
        {hoverIndex != null && <circle cx={coords[hoverIndex][0]} cy={coords[hoverIndex][1]} r="4" className="credit-trend__dot credit-trend__dot--hover" />}
      </svg>

      {hover && hoverLeftPct != null && (
        <div className="credit-trend__tooltip" style={{ left: `${hoverLeftPct}%` }}>
          <div className="credit-trend__tooltip-value">{fmtPts(hover.average)}</div>
          <div className="credit-trend__tooltip-date">{monthYear(hover.date)}</div>
        </div>
      )}

      <div className="credit-trend__endpoints">
        <span>{shortDate(series[0].date)}</span>
        <span>{shortDate(series[series.length - 1].date)}</span>
      </div>
    </div>
  );
}

/** History list, most recent first — lets Mike fix a fat-fingered entry or
 * remove one, without turning this into a full spreadsheet: only
 * CreditKarma/CreditWise are ever editable here (CreditSesame/Discover-Fico
 * are frozen historical values, read-only from here on — see the
 * migration's own comment on why those two columns still exist at all). */
function EntryHistory({
  entries,
  onUpdate,
  onDelete,
}: {
  entries: CreditScoreEntry[];
  onUpdate: (entryDate: string, patch: { creditkarma?: number | null; creditwise?: number | null }) => Promise<void>;
  onDelete: (entryDate: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editingDate, setEditingDate] = useState<string | null>(null);
  const [editKarma, setEditKarma] = useState('');
  const [editWise, setEditWise] = useState('');

  const sorted = useMemo(() => [...entries].sort((a, b) => b.entry_date.localeCompare(a.entry_date)), [entries]);
  const visible = expanded ? sorted : sorted.slice(0, 6);

  function startEdit(e: CreditScoreEntry) {
    setEditingDate(e.entry_date);
    setEditKarma(e.creditkarma != null ? String(e.creditkarma) : '');
    setEditWise(e.creditwise != null ? String(e.creditwise) : '');
  }

  async function saveEdit(entryDate: string) {
    const karma = editKarma.trim() === '' ? null : Number(editKarma);
    const wise = editWise.trim() === '' ? null : Number(editWise);
    await onUpdate(entryDate, { creditkarma: Number.isFinite(karma) ? karma : null, creditwise: Number.isFinite(wise) ? wise : null });
    setEditingDate(null);
  }

  return (
    <div className="credit-history">
      {visible.map((e) => {
        const isHistorical = e.creditsesame != null || e.discover_fico != null;
        return (
          <div key={e.entry_date} className="credit-history__row">
            <span className="credit-history__date">{monthYear(e.entry_date)}</span>
            {editingDate === e.entry_date ? (
              <>
                <input className="credit-history__input" type="number" value={editKarma} placeholder="CreditKarma" onChange={(ev) => setEditKarma(ev.target.value)} autoFocus />
                <input className="credit-history__input" type="number" value={editWise} placeholder="CreditWise" onChange={(ev) => setEditWise(ev.target.value)} />
                <button type="button" className="btn btn--ghost credit-history__action" onClick={() => saveEdit(e.entry_date)}>
                  Save
                </button>
                <button type="button" className="btn btn--ghost credit-history__action" onClick={() => setEditingDate(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <span className="credit-history__value">CK {e.creditkarma ?? '—'}</span>
                <span className="credit-history__value">CW {e.creditwise ?? '—'}</span>
                {isHistorical && <span className="credit-history__tag">historical</span>}
                <button type="button" className="credit-history__icon-btn" title="Edit" onClick={() => startEdit(e)}>
                  ✎
                </button>
                <button type="button" className="credit-history__icon-btn" title="Delete" onClick={() => onDelete(e.entry_date)}>
                  ✕
                </button>
              </>
            )}
          </div>
        );
      })}
      {sorted.length > 6 && (
        <button type="button" className="chip credit-history__toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : `Show all ${sorted.length} entries`}
        </button>
      )}
    </div>
  );
}

export function CreditScoreDashboard() {
  const [entries, setEntries] = useState<CreditScoreEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [karmaTuInput, setKarmaTuInput] = useState('');
  const [karmaEqInput, setKarmaEqInput] = useState('');
  const [wiseInput, setWiseInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(() => {
    api.listCreditScore().then(setEntries).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const thisMonthEntry = useMemo(() => {
    if (!entries) return null;
    const month = todayLocalISO().slice(0, 7);
    return entries.find((e) => e.entry_date.slice(0, 7) === month) ?? null;
  }, [entries]);

  useEffect(() => {
    // Prefills from the stored TransUnion/Equifax breakdown when this
    // month's entry has one; a month imported before that breakdown
    // existed only has the single blended creditkarma value, which can't
    // be split back apart, so those two fields just start blank.
    setKarmaTuInput(thisMonthEntry?.creditkarma_transunion != null ? String(thisMonthEntry.creditkarma_transunion) : '');
    setKarmaEqInput(thisMonthEntry?.creditkarma_equifax != null ? String(thisMonthEntry.creditkarma_equifax) : '');
    setWiseInput(thisMonthEntry?.creditwise != null ? String(thisMonthEntry.creditwise) : '');
  }, [thisMonthEntry]);

  const summary = useMemo(() => buildCreditScoreSummary(entries ?? []), [entries]);

  async function submitEntry() {
    setSaveError(null);
    const tu = karmaTuInput.trim() === '' ? null : Number(karmaTuInput);
    const eq = karmaEqInput.trim() === '' ? null : Number(karmaEqInput);
    const wise = wiseInput.trim() === '' ? null : Number(wiseInput);
    if (
      (karmaTuInput.trim() !== '' && !Number.isFinite(tu)) ||
      (karmaEqInput.trim() !== '' && !Number.isFinite(eq)) ||
      (wiseInput.trim() !== '' && !Number.isFinite(wise))
    ) {
      setSaveError('Enter a number for each score.');
      return;
    }
    setSaving(true);
    try {
      await api.addCreditScoreEntry({ creditkarma_transunion: tu, creditkarma_equifax: eq, creditwise: wise });
      load();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function updateEntry(entryDate: string, patch: { creditkarma?: number | null; creditwise?: number | null }) {
    await api.updateCreditScoreEntry(entryDate, patch);
    load();
  }

  async function confirmDelete() {
    if (!deleting) return;
    await api.deleteCreditScoreEntry(deleting);
    setDeleting(null);
    load();
  }

  if (error) return <div className="empty-state">Couldn't load credit score data: {error}</div>;
  if (!entries) return <div className="empty-state">Loading…</div>;

  return (
    <div>
      <div className={`credit-score__summary card${summary.isNewAllTimeHigh ? ' is-high' : summary.isNewAllTimeLow ? ' is-low' : ''}`}>
        <div className="credit-score__headline">{summary.headline}</div>
        {summary.detail && <div className="credit-score__detail">{summary.detail}</div>}
      </div>

      {summary.series.length > 0 && (
        <>
          <div className="dashboard-page__tiles">
            <StatTile label="Average score" value={summary.latest ? fmtPts(summary.latest.average) : null} aside={summary.latest ? monthYear(summary.latest.date) : null} />
            <StatTile
              label="Since last month"
              value={summary.monthChange ? fmtSigned(summary.monthChange.delta) : null}
              delta={
                summary.monthChange ? (
                  <span className={`dashboard-page__tile-delta${summary.direction === 'up' ? ' is-up' : summary.direction === 'down' ? ' is-down' : ''}`}>
                    {fmtSigned(summary.monthChange.deltaPct * 100, '%')}
                  </span>
                ) : null
              }
            />
            <StatTile label="Since last year" value={summary.yearChange ? fmtSigned(summary.yearChange.delta) : null} aside={summary.yearChange ? `vs. ${monthYear(summary.yearChange.refDate)}` : null} />
            <StatTile label="All-time high" value={summary.allTimeHigh ? fmtPts(summary.allTimeHigh.average) : null} aside={summary.allTimeHigh ? monthYear(summary.allTimeHigh.date) : null} highlight={summary.isNewAllTimeHigh ? 'high' : undefined} />
            <StatTile label="All-time low" value={summary.allTimeLow ? fmtPts(summary.allTimeLow.average) : null} aside={summary.allTimeLow ? monthYear(summary.allTimeLow.date) : null} highlight={summary.isNewAllTimeLow ? 'low' : undefined} />
          </div>

          <div className="dashboard-page__trend-panel card">
            <div className="stats-page__section-title">Score trend</div>
            <CreditTrendChart series={summary.series} allTimeHigh={summary.allTimeHigh} allTimeLow={summary.allTimeLow} />
          </div>
        </>
      )}

      <div className="credit-score__add card">
        <div className="stats-page__section-title">{thisMonthEntry ? 'Update this month' : 'Add this month'}</div>
        <div className="credit-score__add-group">
          <span className="credit-score__add-group-label">CreditKarma</span>
          <div className="credit-score__add-row">
            <label className="credit-score__add-field">
              <span>TransUnion</span>
              <input type="number" inputMode="numeric" value={karmaTuInput} onChange={(e) => setKarmaTuInput(e.target.value)} placeholder="e.g. 830" />
            </label>
            <label className="credit-score__add-field">
              <span>Equifax</span>
              <input type="number" inputMode="numeric" value={karmaEqInput} onChange={(e) => setKarmaEqInput(e.target.value)} placeholder="e.g. 835" />
            </label>
          </div>
        </div>
        <div className="credit-score__add-row">
          <label className="credit-score__add-field">
            <span>CreditWise</span>
            <input type="number" inputMode="numeric" value={wiseInput} onChange={(e) => setWiseInput(e.target.value)} placeholder="e.g. 850" />
          </label>
          <button type="button" className="btn" onClick={submitEntry} disabled={saving}>
            {saving ? 'Saving…' : thisMonthEntry ? 'Update' : 'Add'}
          </button>
        </div>
        {saveError && <div className="credit-score__add-error">{saveError}</div>}
      </div>

      {entries.length > 0 && (
        <div className="credit-score__history-panel card">
          <div className="stats-page__section-title">Recent entries</div>
          <EntryHistory entries={entries} onUpdate={updateEntry} onDelete={setDeleting} />
        </div>
      )}

      {deleting && (
        <ConfirmModal
          title="Delete this entry?"
          body={`The ${monthYear(deleting)} credit score entry will be permanently deleted.`}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

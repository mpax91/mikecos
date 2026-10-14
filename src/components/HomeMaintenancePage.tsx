import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { HomeMaintData, HomeMaintItem, HomeMaintRecord, HomeMaintStatus } from '../api/types';
import { DetailSheet } from './dash/DetailSheet';
import { DashTitle, InfoTip } from './dash/InfoTip';
import { RangePicker } from './dash/RangePicker';
import { useUrlRange } from './dash/useUrlRange';
import { HomeMaintRecordModal } from './HomeMaintModals';
import { inRange, previousRange, rangeText } from '../utils/dateRange';

const money = (n: number, cents = false) => `$${n.toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
const moneyish = (n: number) => money(n, n % 1 !== 0);
const toDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const fmtDate = (iso: string) => toDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtMonth = (iso: string) => toDate(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
const every = (m: number) => (m % 12 === 0 ? (m === 12 ? 'Every Year' : `Every ${m / 12} Years`) : m === 1 ? 'Every Month' : `Every ${m} Months`);
const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86400000);
const sum = (rs: HomeMaintRecord[]) => rs.reduce((n, r) => n + (r.amount ?? 0), 0);

const STATUS_LABEL: Record<HomeMaintStatus, string> = {
  overdue: 'Overdue',
  due_soon: 'Due Soon',
  ok: 'On Track',
  unknown: 'Needs a Date',
  history: 'History Only',
  paused: 'Paused',
};
const STATUS_ORDER: Record<HomeMaintStatus, number> = { overdue: 0, due_soon: 1, unknown: 2, ok: 3, history: 4, paused: 5 };

function dueText(i: HomeMaintItem, today: string): string {
  if (!i.nextDue) return i.status === 'unknown' ? 'No receipt yet — add the last time it was done' : '';
  const d = daysBetween(today, i.nextDue);
  if (d < 0) return `Was due ${fmtDate(i.nextDue)} (${Math.abs(d)} days ago)`;
  if (d === 0) return 'Due today';
  if (d <= 60) return `Due ${fmtDate(i.nextDue)} (in ${d} days)`;
  return `Due ${fmtMonth(i.nextDue)}`;
}

type Sheet = { kind: 'records'; title: string; sub?: string; records: HomeMaintRecord[] } | { kind: 'item'; itemId: string } | { kind: 'items'; title: string; items: HomeMaintItem[] };

/** Home → 🔧 Maintenance: what the house needs and when, every service done
 * (read from the receipt names in the Drive folder "Home Maintenance"), and
 * what upkeep costs. Recurring items are set up in Settings → Home
 * Maintenance; due ones put a "Schedule …" task on Today. */
export function HomeMaintenancePage() {
  const [data, setData] = useState<HomeMaintData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [editing, setEditing] = useState<HomeMaintRecord | 'new' | null>(null);
  const [newSystem, setNewSystem] = useState<string | undefined>();
  const [query, setQuery] = useState('');

  const load = useCallback(() => {
    api
      .getHomeMaint()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(load, [load]);

  const dated = useMemo(() => (data?.records ?? []).filter((r) => r.date && !r.missing), [data]);
  const earliest = useMemo(() => dated.reduce((m, r) => (r.date! < m ? r.date! : m), data?.today ?? '2000-01-01'), [dated, data]);
  const [range, setRange] = useUrlRange(earliest, 'all');
  const prevR = previousRange(range);

  if (error) return <div className="empty-state">Couldn’t load Home Maintenance — {error}</div>;
  if (!data) return <div className="empty-state">Loading…</div>;

  const today = data.today;
  const byId = new Map(data.records.map((r) => [r.id, r]));
  const inR = dated.filter((r) => inRange(r.date!, range));
  const inP = prevR ? dated.filter((r) => inRange(r.date!, prevR)) : [];
  const spent = sum(inR);
  const spentPrev = prevR && inP.length ? sum(inP) : null;
  const needs = data.items.filter((i) => i.status === 'overdue' || i.status === 'due_soon');
  const overdue = needs.filter((i) => i.status === 'overdue');
  const scheduled = data.items
    .filter((i) => i.status !== 'history' && i.status !== 'paused')
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (a.nextDue ?? '9').localeCompare(b.nextDue ?? '9'));
  // The next job after whatever already needs scheduling.
  const nextUp = scheduled.filter((i) => i.status === 'ok' && i.nextDue).sort((a, b) => a.nextDue!.localeCompare(b.nextDue!))[0] ?? null;
  const problems = data.records.filter((r) => r.parseError || r.missing || !r.date);

  const years = new Map<string, HomeMaintRecord[]>();
  for (const r of dated) years.set(r.date!.slice(0, 4), [...(years.get(r.date!.slice(0, 4)) ?? []), r]);
  const yearRows = [...years.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  const maxYear = Math.max(1, ...yearRows.map(([, rs]) => sum(rs)));

  const systems = new Map<string, HomeMaintRecord[]>();
  for (const r of inR) systems.set(r.system ?? 'Other', [...(systems.get(r.system ?? 'Other') ?? []), r]);
  const systemRows = [...systems.entries()].sort((a, b) => sum(b[1]) - sum(a[1]) || b[1].length - a[1].length);
  const maxSystem = Math.max(1, ...systemRows.map(([, rs]) => sum(rs)));

  const q = query.trim().toLowerCase();
  const history = inR.filter((r) => !q || `${r.system} ${r.vendor} ${r.service} ${r.notes} ${r.fileName}`.toLowerCase().includes(q));
  const change = spentPrev ? (spent - spentPrev) / spentPrev : null;

  async function scan() {
    setScanning(true);
    setScanNote(null);
    try {
      const r = await api.scanHomeMaint();
      setScanNote(r.error ? r.error : `${r.listed} file${r.listed === 1 ? '' : 's'} in the folder · ${r.added} new · ${r.updated} changed`);
      load();
    } catch (e) {
      setScanNote(String(e));
    } finally {
      setScanning(false);
    }
  }

  const sheetItem = sheet?.kind === 'item' ? data.items.find((i) => i.id === sheet.itemId) : null;

  return (
    <div className="fin-dash hm-dash">
      {problems.length > 0 && (
        <div className="fin-dash__flags">
          <button
            type="button"
            className="fin-dash__flag fin-dash__flag--warn hm-flag"
            onClick={() => setSheet({ kind: 'records', title: 'Receipts to Fix', sub: 'Rename the file in Drive (or tap to fill it in by hand)', records: problems })}
          >
            <span className="fin-dash__flag-icon">⚠</span>
            <span className="fin-dash__flag-msg">
              {problems.length} receipt{problems.length === 1 ? '' : 's'} need{problems.length === 1 ? 's' : ''} a look — {problems.filter((r) => r.missing).length ? 'some left the folder, ' : ''}
              {problems.filter((r) => r.parseError).length ? 'some names couldn’t be read' : 'tap to review'}
            </span>
          </button>
        </div>
      )}

      <div className="dash-controls hm-controls">
        <RangePicker value={range} onChange={setRange} today={today} earliest={earliest} presets={['ytd', '1y', 'all']} />
        <span className="dash-controls__range-text">
          {rangeText(range)}
          {prevR ? ` · vs ${rangeText(prevR)}` : ''}{' '}
          <InfoTip label="How Home Maintenance works">
            <p>
              Drop each receipt in the Google Drive folder <strong>{data.folder.expectedName}</strong>, named
            </p>
            <p>
              <code>YYYY.MM.DD - System - Vendor - Service - $Amount.pdf</code>
              <br />
              e.g. <code>2026.10.12 - Septic - ABC Septic - Pump-Out - $525.pdf</code>
            </p>
            <p>Systems: {data.systems.join(', ')}. MikeOS reads the name only (nightly, or Scan Now) — no need to type anything in.</p>
            <p>
              Recurring items live in Settings → Home Maintenance. The newest matching receipt sets the next due date; a “Schedule …” task lands on Today ahead of it and checks itself off when the
              next receipt arrives.
            </p>
          </InfoTip>
        </span>
        <span className="hm-controls__actions">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              setNewSystem(undefined);
              setEditing('new');
            }}
          >
            + Add Service
          </button>
          <Link to="/settings?cat=home-maintenance" className="settings-gear-link" title="Home Maintenance Settings" aria-label="Home Maintenance Settings">
            ⚙️
          </Link>
        </span>
      </div>

      <div className="fin-dash__stats">
        <button type="button" className="fin-dash__stat" onClick={() => setSheet({ kind: 'items', title: 'Needs Scheduling', items: needs })}>
          <span className="fin-dash__stat-label">Needs Scheduling</span>
          <span className={`fin-dash__stat-value${overdue.length ? ' fin-dash__neg' : ''}`}>{needs.length}</span>
          <span className="fin-dash__stat-sub">{overdue.length ? `${overdue.length} overdue` : needs.length ? needs.map((i) => i.name).join(', ') : 'Nothing due'}</span>
        </button>
        <button type="button" className="fin-dash__stat" onClick={() => nextUp && setSheet({ kind: 'item', itemId: nextUp.id })} disabled={!nextUp}>
          <span className="fin-dash__stat-label">Next Up</span>
          <span className="fin-dash__stat-value">{nextUp ? fmtMonth(nextUp.nextDue!) : '—'}</span>
          <span className="fin-dash__stat-sub">{nextUp ? nextUp.name : 'Add recurring items in Settings'}</span>
        </button>
        <button type="button" className="fin-dash__stat" onClick={() => setSheet({ kind: 'records', title: `Spent · ${range.label}`, records: inR })}>
          <span className="fin-dash__stat-label">Spent</span>
          <span className="fin-dash__stat-value">{money(spent)}</span>
          <span className="fin-dash__stat-sub">
            {change === null
              ? `${inR.filter((r) => r.amount == null).length ? `${inR.filter((r) => r.amount == null).length} without an amount` : range.label}`
              : `${change >= 0 ? '+' : '−'}${Math.abs(change * 100).toFixed(0)}% vs previous`}
          </span>
        </button>
        <button type="button" className="fin-dash__stat" onClick={() => setSheet({ kind: 'records', title: `Services · ${range.label}`, records: inR })}>
          <span className="fin-dash__stat-label">Services</span>
          <span className="fin-dash__stat-value">{inR.length}</span>
          <span className="fin-dash__stat-sub">{inR[0] ? `Latest ${fmtDate(inR[0].date!)}` : 'None in range'}</span>
        </button>
      </div>

      <div className="fin-dash__grid">
        <section className="fin-dash__card hm-full">
          <DashTitle
            info={
              <p>
                Every recurring item from Settings → Home Maintenance, soonest first. Tap one for its history. “Needs a Date” means no receipt matches it yet — add the last time it was done, or set
                Next Due in Settings.
              </p>
            }
          >
            Schedule
          </DashTitle>
          {scheduled.length === 0 ? (
            <p className="hm-empty">
              No recurring items yet — <Link to="/settings?cat=home-maintenance">add them in Settings</Link>.
            </p>
          ) : (
            <ul className="hm-schedule">
              {scheduled.map((i) => {
                const last = i.lastRecordId ? byId.get(i.lastRecordId) : null;
                return (
                  <li key={i.id}>
                    <button type="button" className="hm-schedule__row" onClick={() => setSheet({ kind: 'item', itemId: i.id })}>
                      <span className={`hm-chip hm-chip--${i.status}`}>{STATUS_LABEL[i.status]}</span>
                      <span className="hm-schedule__main">
                        <span className="hm-schedule__name">{i.name}</span>
                        <span className="hm-schedule__sub">
                          {[
                            dueText(i, today),
                            i.intervalMonths ? every(i.intervalMonths) : null,
                            last ? `Last ${fmtDate(last.date!)}${last.amount != null ? ` · ${moneyish(last.amount)}` : ''}` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      {i.taskId && <span className="hm-schedule__task">On Today</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>Spending by system in the selected range. Tap one for its services.</p>}>By System</DashTitle>
          {systemRows.length === 0 ? (
            <p className="hm-empty">Nothing in this range.</p>
          ) : (
            <div className="fin-dash__years">
              {systemRows.map(([sys, rs]) => (
                <button type="button" key={sys} className="fin-dash__year hm-system" onClick={() => setSheet({ kind: 'records', title: `${sys} · ${range.label}`, records: rs })}>
                  <span className="fin-dash__year-label">{sys}</span>
                  <span className="fin-dash__year-track">
                    <span className="fin-dash__year-bar" style={{ width: `${(sum(rs) / maxSystem) * 100}%` }} />
                  </span>
                  <span className="fin-dash__year-value">{money(sum(rs))}</span>
                  <span className="fin-dash__year-bills">{rs.length}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>Everything spent on upkeep by year, from the receipts’ amounts. Tap a year for its services.</p>}>Spend by Year</DashTitle>
          {yearRows.length === 0 ? (
            <p className="hm-empty">No receipts yet.</p>
          ) : (
            <div className="fin-dash__years">
              {yearRows.map(([y, rs]) => (
                <button type="button" key={y} className="fin-dash__year" onClick={() => setSheet({ kind: 'records', title: `${y} Services`, records: rs })}>
                  <span className="fin-dash__year-label">{y}</span>
                  <span className="fin-dash__year-track">
                    <span className="fin-dash__year-bar" style={{ width: `${(sum(rs) / maxYear) * 100}%` }} />
                  </span>
                  <span className="fin-dash__year-value">{money(sum(rs))}</span>
                  <span className="fin-dash__year-bills">{rs.length}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="fin-dash__card hm-full">
          <div className="fin-dash__card-head">
            <DashTitle info={<p>Every service in the selected range, newest first. Tap one to see the receipt or correct it — a correction sticks until the file is renamed.</p>}>
              Service History
            </DashTitle>
            <input className="hm-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search vendor, service…" aria-label="Search services" />
          </div>
          <RecordList records={history} onOpen={setEditing} />
          <p className="fin-dash__stat-sub hm-footer">
            {data.records.length} record{data.records.length === 1 ? '' : 's'}
            {data.folder.lastScanAt
              ? ` · folder checked ${new Date(data.folder.lastScanAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
              : ' · folder not checked yet'}
            {data.folder.url && (
              <>
                {' · '}
                <a href={data.folder.url} target="_blank" rel="noreferrer">
                  Drive Folder ↗
                </a>
              </>
            )}
            {' · '}
            <button type="button" className="btn btn--ghost btn--sm" onClick={scan} disabled={scanning}>
              {scanning ? 'Scanning…' : 'Scan Now'}
            </button>
          </p>
          {(scanNote || data.folder.lastError) && <p className="home-net-modal__error">{scanNote ?? data.folder.lastError}</p>}
        </section>
      </div>

      {sheet?.kind === 'records' && (
        <DetailSheet title={sheet.title} sub={sheet.sub ?? `${sheet.records.length} service${sheet.records.length === 1 ? '' : 's'} · ${money(sum(sheet.records))}`} onClose={() => setSheet(null)}>
          <RecordList records={sheet.records} onOpen={setEditing} />
        </DetailSheet>
      )}

      {sheet?.kind === 'items' && (
        <DetailSheet title={sheet.title} sub={sheet.items.length ? 'Each has a “Schedule …” task on Today' : undefined} onClose={() => setSheet(null)}>
          {sheet.items.length === 0 ? (
            <p className="hm-empty">Nothing needs scheduling right now.</p>
          ) : (
            <ul className="hm-schedule">
              {sheet.items.map((i) => (
                <li key={i.id}>
                  <button type="button" className="hm-schedule__row" onClick={() => setSheet({ kind: 'item', itemId: i.id })}>
                    <span className={`hm-chip hm-chip--${i.status}`}>{STATUS_LABEL[i.status]}</span>
                    <span className="hm-schedule__main">
                      <span className="hm-schedule__name">{i.name}</span>
                      <span className="hm-schedule__sub">{dueText(i, today)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DetailSheet>
      )}

      {sheetItem && (
        <DetailSheet
          title={sheetItem.name}
          sub={`${sheetItem.system}${sheetItem.intervalMonths ? ` · ${every(sheetItem.intervalMonths)}` : ''} · ${STATUS_LABEL[sheetItem.status]}`}
          onClose={() => setSheet(null)}
        >
          <ItemDetail
            item={sheetItem}
            today={today}
            records={sheetItem.recordIds.map((id) => byId.get(id)!).filter(Boolean)}
            onOpen={setEditing}
            onAdd={() => {
              setNewSystem(sheetItem.system);
              setEditing('new');
            }}
          />
        </DetailSheet>
      )}

      {editing && (
        <HomeMaintRecordModal
          record={editing === 'new' ? null : editing}
          systems={data.systems}
          defaults={{ system: newSystem }}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setSheet((s) => (s?.kind === 'item' ? s : null));
            load();
          }}
        />
      )}
    </div>
  );
}

function RecordList({ records, onOpen }: { records: HomeMaintRecord[]; onOpen: (r: HomeMaintRecord) => void }) {
  if (!records.length) return <p className="hm-empty">No services.</p>;
  const label = (r: HomeMaintRecord) => r.service ?? r.fileName ?? '—';
  return (
    <>
      <div className="fin-dash__table-wrap post-table">
        <table className="fin-dash__table">
          <thead>
            <tr>
              <th>Date</th>
              <th>System</th>
              <th>Vendor</th>
              <th>Service</th>
              <th className="hm-num">Amount</th>
              <th>Receipt</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id} className="bee-social__row" onClick={() => onOpen(r)}>
                <td>{r.date ? fmtDate(r.date) : <span className="fin-dash__neg">No date</span>}</td>
                <td>{r.system ?? '—'}</td>
                <td>{r.vendor ?? '—'}</td>
                <td>
                  {label(r)}
                  {r.notes && (
                    <span className="hm-note-dot" title={r.notes}>
                      {' '}
                      📝
                    </span>
                  )}
                </td>
                <td className="hm-num">{r.amount != null ? moneyish(r.amount) : '—'}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  {r.fileUrl ? (
                    <a href={r.fileUrl} target="_blank" rel="noreferrer">
                      Open ↗
                    </a>
                  ) : r.source === 'manual' ? (
                    <span className="hm-muted">Typed In</span>
                  ) : (
                    '—'
                  )}
                  {(r.parseError || r.missing) && <span className="hm-chip hm-chip--overdue">{r.missing ? 'Gone' : 'Fix'}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="post-cards">
        {records.map((r) => (
          <li key={`c-${r.id}`}>
            <button type="button" className="post-card" onClick={() => onOpen(r)}>
              <span className="post-card__top">
                {r.date ? fmtDate(r.date) : 'No date'} · {r.system ?? '—'}
                {(r.parseError || r.missing) && <span className="hm-chip hm-chip--overdue">{r.missing ? 'Gone' : 'Fix'}</span>}
              </span>
              <span className="post-card__title paypal-dash__card-title">
                <span>
                  {label(r)}
                  {r.vendor ? ` · ${r.vendor}` : ''}
                </span>
                <span>{r.amount != null ? moneyish(r.amount) : '—'}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function ItemDetail({ item, today, records, onOpen, onAdd }: { item: HomeMaintItem; today: string; records: HomeMaintRecord[]; onOpen: (r: HomeMaintRecord) => void; onAdd: () => void }) {
  const priced = records.filter((r) => r.amount != null);
  const avg = priced.length ? sum(priced) / priced.length : null;
  const gaps = records.slice(0, -1).map((r, i) => daysBetween(records[i + 1].date!, r.date!));
  const avgGapMonths = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length / 30.44) : null;
  return (
    <div className="hm-item">
      <dl className="adt__kv">
        <dt>Next Due</dt>
        <dd>{item.nextDue ? `${fmtDate(item.nextDue)}${item.overrideActive ? ' (set by hand)' : ''}` : '—'}</dd>
        {item.remindOn && item.status === 'ok' && (
          <>
            <dt>Task on Today</dt>
            <dd>{fmtDate(item.remindOn)}</dd>
          </>
        )}
        <dt>Status</dt>
        <dd>
          {dueText(item, today) || STATUS_LABEL[item.status]}
          {item.taskId && ' · “Schedule …” task is on Today'}
        </dd>
        <dt>Times Done</dt>
        <dd>
          {records.length}
          {avgGapMonths !== null && ` · about every ${avgGapMonths >= 24 ? `${(avgGapMonths / 12).toFixed(1).replace(/\.0$/, '')} years` : `${avgGapMonths} months`}`}
        </dd>
        <dt>Cost</dt>
        <dd>{priced.length ? `${money(sum(priced))} total · ${moneyish(Math.round(avg! * 100) / 100)} average${priced.length >= 2 ? ` · last ${moneyish(priced[0].amount!)}` : ''}` : '—'}</dd>
        {item.matchWords && (
          <>
            <dt>Counts</dt>
            <dd>
              {item.system} receipts mentioning {item.matchWords}
            </dd>
          </>
        )}
        {item.notes && (
          <>
            <dt>Notes</dt>
            <dd>{item.notes}</dd>
          </>
        )}
      </dl>
      <div className="hm-item__actions">
        <button type="button" className="btn btn--sm" onClick={onAdd}>
          + Add a Past Service
        </button>
        <Link to="/settings?cat=home-maintenance" className="btn btn--ghost btn--sm">
          Edit Schedule
        </Link>
      </div>
      <h4 className="hm-item__heading">History</h4>
      <RecordList records={records} onOpen={onOpen} />
    </div>
  );
}

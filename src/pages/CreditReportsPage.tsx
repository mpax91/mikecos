import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { CreditBureau, CreditCheck, CreditMergedAccount, CreditReportsResponse } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';
import { FinanceLineChart } from '../components/FinanceLineChart';
import { DashTitle, InfoTip } from '../components/dash/InfoTip';
import { DetailSheet } from '../components/dash/DetailSheet';
import { SectionPicker } from '../components/dash/SectionPicker';
import { KebabMenu } from '../components/KebabMenu';
import { BUREAU_LABEL, BUREAU_SHORT, REAL_BUREAUS, compactMoney, driveFileUrl, fullDate, kindGroup, kindLabel, money, monthYear, statusLabel } from '../utils/creditReports';

type Tab = 'overview' | 'accounts' | 'inquiries' | 'reports';
const TABS: [Tab, string][] = [
  ['overview', 'Overview'],
  ['accounts', 'Accounts'],
  ['inquiries', 'Inquiries'],
  ['reports', 'Reports'],
];
type AcctFilter = 'open' | 'closed' | 'all';
const ACCT_FILTERS: [AcctFilter, string][] = [
  ['open', 'Open'],
  ['closed', 'Closed'],
  ['all', 'All'],
];
type Sheet = { kind: 'account'; key: string } | { kind: 'report'; id: string } | { kind: 'metric'; metric: 'open' | 'age' | 'cards' | 'inquiries' | 'lates' } | { kind: 'personal' } | null;

const DRIVE_FOLDER = 'https://drive.google.com/drive/folders/0B_dQuoTf0crGMmMwdnp5Z2RBTms';
const BUREAU_COLOR: Record<CreditBureau, string> = { equifax: '#2A6FB0', experian: '#C0662E', transunion: '#5B8C3A', other: '#888' };
const yearX = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)) || 15);
const fmtYear = (ms: number) => String(new Date(ms).getUTCFullYear());

/** Finance → Credit Reports (Mike, 2026-10-16): the yearly AnnualCreditReport
 * pulls (Feb 22) from the Drive "Credit Reports" folder, read once and
 * imported. Accounts are merged across bureaus and years in the worker
 * (worker/src/credit/summary.ts); checks are rule-based. */
export function CreditReportsPage() {
  useReportTabMeta('Credit Reports', 'finance');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<CreditReportsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [importing, setImporting] = useState(false);
  const [allChecks, setAllChecks] = useState(false);
  const [q, setQ] = useState('');
  const [scanning, setScanning] = useState<string | null>(null);
  // Scan Drive Now: keep going while files are queued (each pass reads a few PDFs).
  const scanNow = async () => {
    setScanning('Checking Drive…');
    try {
      for (let pass = 0; pass < 6; pass++) {
        const r = await api.scanCreditReports();
        if (r.error) {
          setScanning(r.error);
          break;
        }
        setScanning(
          r.queued
            ? `Read ${r.read + r.imported} so far…`
            : `Checked ${r.listed} files${r.read + r.imported ? ` · loaded ${r.read + r.imported}` : ''}${r.notRead ? ` · ${r.notRead} not read yet` : ''}`,
        );
        if (!r.queued) break;
      }
    } catch (e) {
      setScanning(e instanceof Error ? e.message : String(e));
    }
    load();
  };

  const load = useCallback(() => {
    api
      .getCreditReports()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const tab = (TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'overview') as Tab;
  const filter = (ACCT_FILTERS.some(([k]) => k === params.get('show')) ? params.get('show') : 'open') as AcctFilter;
  const setParam = (k: string, v: string, dflt: string) => {
    const next = new URLSearchParams(params);
    if (v === dflt) next.delete(k);
    else next.set(k, v);
    setParams(next, { replace: true });
  };
  const openAccount = (key: string) => setSheet({ kind: 'account', key });

  const s = data?.stats;
  const accounts = data?.accounts ?? [];
  const shownAccounts = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return accounts
      .filter((a) => (filter === 'open' ? a.status === 'open' : filter === 'closed' ? a.status !== 'open' : true))
      .filter((a) => !needle || `${a.name} ${kindLabel(a.kind)} ${a.statusText ?? ''}`.toLowerCase().includes(needle))
      .sort((a, b) => (b.opened ?? '').localeCompare(a.opened ?? ''));
  }, [accounts, filter, q]);

  return (
    <div className="finance-page credit-page">
      <div className="breadcrumb">
        <button type="button" className="breadcrumb__back" onClick={() => navigate('/finance')} title="Back" aria-label="Back">
          ‹
        </button>
        <Link to="/finance" className="breadcrumb__link">
          Finance
        </Link>
        <span className="breadcrumb__sep">›</span>
        <span className="breadcrumb__current">Credit Reports</span>
      </div>

      <div className="links-page__header">
        <h1 className="heading-serif dash-title" style={{ fontSize: 24, margin: '0 0 2px' }}>
          Credit Reports
          <InfoTip label="About Credit Reports">
            <p>
              Your free yearly reports from Equifax, Experian and TransUnion (AnnualCreditReport.com, every Feb 22), plus a few older pulls. They were read once from the PDFs in the Drive “Credit
              Reports” folder; accounts are matched across bureaus and years.
            </p>
            <p>The monthly score check (Dashboard → Credit Score) tracks the number; these reports are the detail behind it — every account, late payment, inquiry and address the bureaus hold.</p>
            <p>No Social Security numbers, birth dates or full account numbers are stored.</p>
          </InfoTip>
        </h1>
        <KebabMenu
          items={[
            { label: 'Scan Drive Now', onClick: scanNow },
            { label: 'Open Drive Folder', onClick: () => window.open(data?.drive.folderUrl ?? DRIVE_FOLDER, '_blank', 'noopener') },
            { label: 'Import Reports (JSON)…', onClick: () => setImporting(true) },
          ]}
        />
      </div>
      {s && data!.reports.length > 0 && (
        <p className="links-page__subhead">
          {data!.reports.length} reports · {data!.reports[0].pulledOn.slice(0, 4)}–{s.latestPull?.slice(0, 4)} · Latest pull {fullDate(s.latestPull)} · Next pull {fullDate(s.nextPull)} (on Today)
        </p>
      )}
      {data && (
        <div className="credit-page__drive">
          <span className="fin-dash__muted">
            📁 Drive folder “{data.drive.folder ?? 'Credit Reports'}” ·{' '}
            {data.drive.lastScanAt ? `checked ${new Date(data.drive.lastScanAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'not checked yet'}
          </span>
          <button type="button" className="btn btn--sm" onClick={scanNow} disabled={!!scanning && scanning.endsWith('…')}>
            Scan Drive Now
          </button>
        </div>
      )}

      {scanning && <p className="credit-page__scan">{scanning}</p>}
      {data && data.drive.files.some((f) => f.status === 'not_read') && (
        <button type="button" className="credit-page__unread" onClick={() => setParam('tab', 'reports', 'overview')}>
          ⚠ {data.drive.files.filter((f) => f.status === 'not_read').length} file(s) in the Drive folder couldn’t be read automatically — ask Claude to read them →
        </button>
      )}
      {error && <div className="empty-state">Couldn’t load credit reports: {error}</div>}
      {!data && !error && <div className="empty-state empty-state--section">Loading…</div>}
      {data && data.reports.length === 0 && <div className="empty-state">No reports yet. Use ⋯ → Import Reports.</div>}

      {data && s && data.reports.length > 0 && (
        <>
          <SectionPicker options={TABS} value={tab} onChange={(t) => setParam('tab', t, 'overview')} label="Section" className="credit-page__tabs" />

          {tab === 'overview' && (
            <>
              <div className="fin-dash__stats fin-dash__stats--5">
                <Tile label="Open Accounts" value={String(s.openAccounts)} sub={`${s.openCards} cards · ${s.totalAccountsEver} ever`} onClick={() => setSheet({ kind: 'metric', metric: 'open' })} />
                <Tile
                  label="Oldest Account"
                  value={s.oldestOpened ? `${s.oldestOpened.years} yrs` : '—'}
                  sub={s.oldestOpened ? `${s.oldestOpened.name} · avg open ${s.avgAgeOpenYears ?? '—'} yrs` : ''}
                  onClick={() => setSheet({ kind: 'metric', metric: 'age' })}
                />
                <Tile
                  label="Card Use"
                  value={s.utilization !== null ? `${Math.round(s.utilization * 100)}%` : '—'}
                  sub={`${compactMoney(s.revolvingBalance)} of ${compactMoney(s.revolvingLimit)} limits`}
                  tone={s.utilization !== null && s.utilization >= 0.3 ? 'down' : ''}
                  onClick={() => setSheet({ kind: 'metric', metric: 'cards' })}
                />
                <Tile label="Hard Inquiries" value={String(s.hardInquiries2y)} sub="last 2 years" onClick={() => setSheet({ kind: 'metric', metric: 'inquiries' })} />
                <Tile
                  label="Late Payments"
                  value={String(s.latesOnFile)}
                  sub={s.latesEver > s.latesOnFile ? `on file · ${s.latesEver - s.latesOnFile} aged off` : 'on file (7 years)'}
                  tone={s.latesOnFile ? 'down' : ''}
                  onClick={() => setSheet({ kind: 'metric', metric: 'lates' })}
                />
              </div>

              <div className="fin-dash__grid">
                {data.checks.length > 0 && (
                  <section className="fin-dash__card fin-dash__card--full">
                    <DashTitle
                      info={
                        <p>
                          Rule-based checks across the latest pull and earlier years: late marks still on file, accounts one bureau has and another doesn’t, new accounts, inquiries and addresses since
                          the previous pull, and open accounts MikeOS doesn’t know about.
                        </p>
                      }
                    >
                      Things to Check
                    </DashTitle>
                    <ul className="taxes-insights credit-checks">
                      {(allChecks ? data.checks : data.checks.slice(0, 5)).map((c) => (
                        <CheckRow key={c.key} c={c} onAccount={openAccount} />
                      ))}
                    </ul>
                    {data.checks.length > 5 && (
                      <button type="button" className="btn btn--ghost btn--sm taxes-insights__more" onClick={() => setAllChecks((v) => !v)}>
                        {allChecks ? 'Show Fewer' : `Show ${data.checks.length - 5} More`}
                      </button>
                    )}
                  </section>
                )}

                <section className="fin-dash__card fin-dash__card--full">
                  <DashTitle info={<p>Every account any bureau has reported, from the month it opened to when it closed (or today). Red ticks are late payments. Tap an account for its detail.</p>}>
                    Account Timeline
                  </DashTitle>
                  <Timeline accounts={accounts} onOpen={openAccount} />
                </section>

                <section className="fin-dash__card fin-dash__card--wide">
                  <DashTitle info={<p>Open accounts on each bureau’s report, pull by pull. Bureaus rarely agree exactly — some lenders report to only one or two.</p>}>
                    Open Accounts by Bureau
                  </DashTitle>
                  <FinanceLineChart
                    ariaLabel="Open accounts by bureau over time"
                    formatX={fmtYear}
                    formatY={(v) => String(Math.round(v))}
                    series={REAL_BUREAUS.map((b) => ({
                      name: BUREAU_LABEL[b],
                      color: BUREAU_COLOR[b],
                      points: data.reports.filter((r) => r.bureau === b && !r.unreadable && !r.partial && r.accounts > 0).map((r) => ({ x: yearX(r.pulledOn), y: r.open })),
                    }))}
                  />
                </section>

                <section className="fin-dash__card">
                  <DashTitle info={<p>Names, addresses and employers the bureaus have on file. Anything you don’t recognize is worth a dispute — it can be a sign of mixed files or fraud.</p>}>
                    On File About You
                  </DashTitle>
                  <ul className="credit-mini">
                    {data.addresses.slice(0, 4).map((a) => (
                      <li key={a.address}>
                        <span>{a.address}</span>
                        <span className="fin-dash__muted">
                          {a.current ? 'Current · ' : ''}
                          {monthYear(a.firstSeen)}–{monthYear(a.lastSeen)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSheet({ kind: 'personal' })}>
                    All Names, Addresses &amp; Employers ({data.names.length + data.addresses.length + data.employers.length})
                  </button>
                </section>

                {data.scores.length > 0 && (
                  <section className="fin-dash__card">
                    <DashTitle info={<p>Free annual reports don’t include a score. These are the few pulls that printed one (often a different model than the monthly apps use).</p>}>
                      Scores Printed on Reports
                    </DashTitle>
                    <ul className="credit-mini">
                      {data.scores.map((sc, i) => (
                        <li key={i}>
                          <button type="button" className="link-button" onClick={() => setSheet({ kind: 'report', id: sc.reportId })}>
                            {fullDate(sc.pulledOn)} · {sc.bureau ? BUREAU_LABEL[sc.bureau] : 'Report'}
                          </button>
                          <span>
                            <strong>{sc.value}</strong> <span className="fin-dash__muted">{sc.model ?? ''}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                    <Link to="/dashboard" className="btn btn--ghost btn--sm">
                      Monthly Credit Score →
                    </Link>
                  </section>
                )}
              </div>
            </>
          )}

          {tab === 'accounts' && (
            <section className="fin-dash__card fin-dash__card--full">
              <div className="credit-page__filters">
                <SectionPicker options={ACCT_FILTERS} value={filter} onChange={(f) => setParam('show', f, 'open')} label="Accounts" />
                <input className="input credit-page__search" type="search" placeholder="Search accounts" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <AccountTable rows={shownAccounts} onOpen={openAccount} />
            </section>
          )}

          {tab === 'inquiries' && <InquiriesView data={data} />}

          {tab === 'reports' && <DriveCard data={data} onScan={scanNow} />}
          {tab === 'reports' && (
            <section className="fin-dash__card fin-dash__card--full">
              <DashTitle info={<p>Every report in the Drive folder, newest first. Tap one for what it holds and a link to the PDF.</p>}>Reports by Year</DashTitle>
              <div className="credit-years">
                {data.years.map((y) => (
                  <div key={y.year} className="credit-years__row">
                    <span className="credit-years__year">{y.year}</span>
                    <span className="credit-years__chips">
                      {y.reports.map((r) => {
                        const row = data.reports.find((x) => x.id === r.id);
                        return (
                          <button key={r.id} type="button" className={`credit-chip credit-chip--${r.bureau}${row?.unreadable ? ' is-bad' : ''}`} onClick={() => setSheet({ kind: 'report', id: r.id })}>
                            {r.bureau === 'other' ? (row?.source ?? 'Other') : BUREAU_LABEL[r.bureau]}
                            <span className="fin-dash__muted">
                              {' '}
                              · {row ? `${row.accounts} accts` : ''}
                              {row?.partial ? ' · partial' : ''}
                            </span>
                          </button>
                        );
                      })}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {sheet && data && <SheetView sheet={sheet} data={data} onClose={() => setSheet(null)} onAccount={openAccount} onReport={(id) => setSheet({ kind: 'report', id })} onChanged={load} />}
      {importing && (
        <ImportModal
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            load();
          }}
        />
      )}
    </div>
  );
}

const FILE_STATUS: Record<string, string> = { loaded: 'Loaded', read: 'Read by MikeOS', imported: 'Imported', not_read: 'Not read yet', queued: 'Queued' };

function DriveCard({ data, onScan }: { data: CreditReportsResponse; onScan: () => void }) {
  const d = data.drive;
  const files = d.files.filter((f) => f.kind === 'pdf' || f.status !== 'loaded');
  const unread = files.filter((f) => f.status === 'not_read' || f.status === 'queued');
  return (
    <section className="fin-dash__card fin-dash__card--full">
      <DashTitle
        info={
          <>
            <p>
              MikeOS checks the Drive folder “Credit Reports” every night. Name each PDF “YYYY.MM.DD - Bureau.pdf”. PDFs in this year’s Equifax, Experian and TransUnion layouts are read automatically;
              anything it can’t read shows Not read yet — ask Claude to read those, and the .json file it saves in the folder is picked up the same way.
            </p>
          </>
        }
      >
        Drive Folder
      </DashTitle>
      <p className="fin-dash__muted">
        {d.folder ? `“${d.folder}”` : 'Not found yet'} ·{' '}
        {d.lastScanAt ? `checked ${new Date(d.lastScanAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'not checked yet'}
        {d.lastError ? ` · ${d.lastError}` : ''}{' '}
        <button type="button" className="btn btn--ghost btn--sm" onClick={onScan}>
          Scan Drive Now
        </button>
      </p>
      {unread.length > 0 && (
        <ul className="credit-mini">
          {unread.map((f) => (
            <li key={f.fileId}>
              <span className="fin-dash__neg">{f.name}</span>
              <span className="fin-dash__muted">
                {FILE_STATUS[f.status]}
                {f.error ? ` — ${f.error}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary className="fin-dash__muted">All {files.length} files</summary>
        <ul className="credit-mini">
          {files.map((f) => (
            <li key={f.fileId}>
              {f.webUrl ? (
                <a href={f.webUrl} target="_blank" rel="noopener noreferrer">
                  {f.name}
                </a>
              ) : (
                <span>{f.name}</span>
              )}
              <span className="fin-dash__muted" title={f.error ?? ''}>
                {FILE_STATUS[f.status] ?? f.status}
                {f.error ? ' ⓘ' : ''}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function Tile({ label, value, sub, onClick, tone = '' }: { label: string; value: string; sub: string; onClick: () => void; tone?: '' | 'down' }) {
  return (
    <button type="button" className="fin-dash__stat" onClick={onClick}>
      <span className="fin-dash__stat-label">{label}</span>
      <span className={`fin-dash__stat-value${tone === 'down' ? ' fin-dash__neg' : ''}`}>{value}</span>
      <span className="fin-dash__stat-sub">{sub}</span>
    </button>
  );
}

function CheckRow({ c, onAccount }: { c: CreditCheck; onAccount: (k: string) => void }) {
  return (
    <li className={`taxes-insight taxes-insight--${c.tone === 'good' ? 'good' : c.tone === 'warn' ? 'warn' : 'info'}`}>
      <span className="taxes-insight__icon">{c.tone === 'good' ? '✓' : c.tone === 'warn' ? '⚠' : 'ⓘ'}</span>
      <span>
        <strong>{c.title}</strong>
        <span className="taxes-insight__detail"> {c.detail}</span>
        {c.accountKey && (
          <button type="button" className="link-button credit-checks__open" onClick={() => onAccount(c.accountKey!)}>
            Open
          </button>
        )}
      </span>
    </li>
  );
}

function BureauDots({ have }: { have: CreditBureau[] }) {
  return (
    <span className="credit-dots" aria-label={have.map((b) => BUREAU_LABEL[b]).join(', ') || 'none'}>
      {REAL_BUREAUS.map((b) => (
        <span key={b} className={`credit-dot${have.includes(b) ? ` credit-dot--${b}` : ' is-off'}`} title={BUREAU_LABEL[b]}>
          {BUREAU_SHORT[b]}
        </span>
      ))}
    </span>
  );
}

function Timeline({ accounts, onOpen }: { accounts: CreditMergedAccount[]; onOpen: (k: string) => void }) {
  const rows = accounts.filter((a) => a.opened);
  if (!rows.length) return <p className="fin-dash__muted">No open dates on file.</p>;
  const idx = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;
  const now = new Date();
  const end = now.getFullYear() * 12 + now.getMonth();
  const start = Math.min(...rows.map((a) => idx(a.opened!)));
  const firstYear = Math.floor(start / 12);
  const lastYear = now.getFullYear();
  const span = Math.max(1, end - firstYear * 12);
  const pct = (m: number) => `${((m - firstYear * 12) / span) * 100}%`;
  const years: number[] = [];
  for (let y = firstYear; y <= lastYear; y += lastYear - firstYear > 12 ? 2 : 1) years.push(y);
  return (
    <div className="credit-timeline">
      <div className="credit-timeline__axis">
        <span />
        <span className="credit-timeline__track">
          {years.map((y) => (
            <span key={y} className="credit-timeline__tick" style={{ left: pct(y * 12) }}>
              {String(y).slice(2).padStart(2, '0') === String(y).slice(2) ? `’${String(y).slice(2)}` : y}
            </span>
          ))}
        </span>
      </div>
      {rows.map((a) => {
        const from = idx(a.opened!);
        const to = a.status === 'open' ? end : a.closed ? idx(a.closed) : idx(a.lastReported ?? a.lastSeen);
        return (
          <button key={a.key} type="button" className="credit-timeline__row" onClick={() => onOpen(a.key)}>
            <span className="credit-timeline__name">
              {a.name}
              <span className="fin-dash__muted"> · {kindLabel(a.kind)}</span>
            </span>
            <span className="credit-timeline__track">
              <span
                className={`credit-timeline__bar credit-timeline__bar--${kindGroup(a.kind)}${a.status === 'open' ? ' is-open' : ''}`}
                style={{ left: pct(from), width: `calc(${pct(Math.max(to, from + 1))} - ${pct(from)})` }}
              />
              {a.lates.map((l) => (
                <span key={l.month} className="credit-timeline__late" style={{ left: pct(idx(l.month)) }} title={`${l.days} days late ${monthYear(l.month)}`} />
              ))}
            </span>
          </button>
        );
      })}
      <div className="credit-timeline__legend fin-dash__muted">
        <span className="credit-timeline__key credit-timeline__bar--card" /> Cards <span className="credit-timeline__key credit-timeline__bar--loan" /> Loans{' '}
        <span className="credit-timeline__key credit-timeline__bar--home" /> Home <span className="credit-timeline__key credit-timeline__bar--other" /> Other · faded = closed
      </div>
    </div>
  );
}

function AccountTable({ rows, onOpen }: { rows: CreditMergedAccount[]; onOpen: (k: string) => void }) {
  if (!rows.length) return <p className="fin-dash__muted">No accounts match.</p>;
  return (
    <>
      <div className="fin-dash__table-wrap post-table">
        <table className="fin-dash__table credit-table">
          <thead>
            <tr>
              <th>Account</th>
              <th>Type</th>
              <th>Opened</th>
              <th>Status</th>
              <th className="num">Limit / Loan</th>
              <th className="num">Balance</th>
              <th>Bureaus</th>
              <th>Lates</th>
              <th>In MikeOS</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.key} className="is-clickable" onClick={() => onOpen(a.key)}>
                <td>{a.name}</td>
                <td>{kindLabel(a.kind)}</td>
                <td>{monthYear(a.opened)}</td>
                <td>{statusLabel(a.status)}</td>
                <td className="num">{money(a.limit ?? a.highBalance)}</td>
                <td className="num">{money(a.balance)}</td>
                <td>
                  <BureauDots have={a.onLatest ? a.bureausLatest : a.bureausEver} />
                </td>
                <td className={a.lates.some((l) => l.onFile) ? 'fin-dash__neg' : ''}>{a.worstLate ? `${a.worstLate}d` : '—'}</td>
                <td className="fin-dash__muted">{a.inMikeOS ? '✓' : a.known ? 'Mine' : a.status === 'open' ? '—' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="post-cards">
        {rows.map((a) => (
          <button key={a.key} type="button" className="post-card credit-card-row" onClick={() => onOpen(a.key)}>
            <span className="credit-card-row__top">
              <strong>{a.name}</strong>
              <span>{money(a.balance)}</span>
            </span>
            <span className="fin-dash__muted">
              {kindLabel(a.kind)} · {statusLabel(a.status)} · opened {monthYear(a.opened)}
              {a.worstLate ? ` · ${a.worstLate}d late` : ''}
            </span>
            <BureauDots have={a.onLatest ? a.bureausLatest : a.bureausEver} />
          </button>
        ))}
      </div>
    </>
  );
}

function InquiriesView({ data }: { data: CreditReportsResponse }) {
  const [showSoft, setShowSoft] = useState(false);
  const hard = data.inquiries.filter((i) => i.type === 'hard');
  const onFile = hard.filter((i) => i.onFile);
  const older = hard.filter((i) => !i.onFile);
  const soft = data.inquiries.filter((i) => i.type === 'soft');
  const softByLender = useMemo(() => {
    const m = new Map<string, { name: string; n: number; last: string | null }>();
    for (const i of soft) {
      const k = i.name.toUpperCase();
      const e = m.get(k) ?? { name: i.name, n: 0, last: null };
      e.n++;
      if (i.date && (!e.last || i.date > e.last)) e.last = i.date;
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.n - a.n);
  }, [soft]);
  const list = (rows: typeof hard) => (
    <ul className="credit-mini">
      {rows.map((i) => (
        <li key={i.key}>
          <span>
            {i.name} <BureauDots have={i.bureaus} />
          </span>
          <span className="fin-dash__muted">
            {fullDate(i.date)}
            {i.onFile && i.dropsOff ? ` · off ${monthYear(i.dropsOff)}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="fin-dash__grid">
      <section className="fin-dash__card fin-dash__card--wide">
        <DashTitle info={<p>Hard inquiries come from applying for credit; they count against scores for a year and stay on the report for two. Each one should be something you applied for.</p>}>
          Hard Inquiries on File ({onFile.length})
        </DashTitle>
        {onFile.length ? list(onFile) : <p className="fin-dash__muted">None in the last two years.</p>}
      </section>
      <section className="fin-dash__card">
        <DashTitle info={<p>Hard inquiries older than two years, from earlier pulls — already off the reports.</p>}>Older Hard Inquiries ({older.length})</DashTitle>
        {list(older)}
      </section>
      <section className="fin-dash__card fin-dash__card--full">
        <DashTitle info={<p>Soft inquiries — your own checks, account reviews by current lenders, and pre-approved offers. They don’t affect scores.</p>}>Soft Inquiries ({soft.length})</DashTitle>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowSoft((v) => !v)}>
          {showSoft ? 'Hide' : `Show ${softByLender.length} Lenders`}
        </button>
        {showSoft && (
          <ul className="credit-mini">
            {softByLender.map((l) => (
              <li key={l.name}>
                <span>{l.name}</span>
                <span className="fin-dash__muted">
                  {l.n}× · last {fullDate(l.last)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SheetView({
  sheet,
  data,
  onClose,
  onAccount,
  onReport,
  onChanged,
}: {
  sheet: NonNullable<Sheet>;
  data: CreditReportsResponse;
  onClose: () => void;
  onAccount: (k: string) => void;
  onReport: (id: string) => void;
  onChanged: () => void;
}) {
  const s = data.stats;
  if (sheet.kind === 'account') {
    const a = data.accounts.find((x) => x.key === sheet.key);
    if (!a) return null;
    const toggleKnown = () => api.setCreditAccountKnown(a.key, !a.known).then(onChanged);
    return (
      <DetailSheet title={a.name} sub={`${kindLabel(a.kind)} · ${statusLabel(a.status)}${a.owner ? ` · ${a.owner.replace('_', ' ')}` : ''}`} onClose={onClose}>
        <div className="fin-dash__stats fin-dash__stats--4">
          <div className="fin-dash__stat">
            <span className="fin-dash__stat-label">Opened</span>
            <span className="fin-dash__stat-value">{monthYear(a.opened)}</span>
            <span className="fin-dash__stat-sub">{a.closed ? `Closed ${monthYear(a.closed)}` : a.status === 'open' ? 'Still open' : ''}</span>
          </div>
          <div className="fin-dash__stat">
            <span className="fin-dash__stat-label">{a.limit ? 'Limit' : 'Original Amount'}</span>
            <span className="fin-dash__stat-value">{money(a.limit ?? a.highBalance)}</span>
            <span className="fin-dash__stat-sub">{a.monthlyPayment ? `${money(a.monthlyPayment)}/mo` : ''}</span>
          </div>
          <div className="fin-dash__stat">
            <span className="fin-dash__stat-label">Balance</span>
            <span className="fin-dash__stat-value">{money(a.balance)}</span>
            <span className="fin-dash__stat-sub">{a.lastReported ? `as of ${monthYear(a.lastReported)}` : ''}</span>
          </div>
          <div className="fin-dash__stat">
            <span className="fin-dash__stat-label">On Reports</span>
            <span className="fin-dash__stat-value">
              <BureauDots have={a.onLatest ? a.bureausLatest : a.bureausEver} />
            </span>
            <span className="fin-dash__stat-sub">
              {fullDate(a.firstSeen).slice(-4)}–{fullDate(a.lastSeen).slice(-4)}
            </span>
          </div>
        </div>
        {a.statusText && <p>{a.statusText}</p>}
        <p className="fin-dash__muted">
          {a.inMikeOS ? `In MikeOS: ${a.inMikeOS}` : a.known ? 'Marked as yours.' : a.status === 'open' ? 'Not in MikeOS (Wallet or Statements).' : ''}
          {!a.inMikeOS && a.status === 'open' && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={toggleKnown}>
              {a.known ? 'Undo Mark as Mine' : 'Mark as Mine'}
            </button>
          )}
        </p>
        {a.lates.length > 0 && (
          <>
            <h4 className="fin-dash__card-title">Late Payments</h4>
            <ul className="credit-mini">
              {a.lates.map((l) => (
                <li key={l.month}>
                  <span className={l.onFile ? 'fin-dash__neg' : ''}>
                    {l.days} days late · {monthYear(l.month)} {l.bureaus.length > 0 && <BureauDots have={l.bureaus} />}
                  </span>
                  <span className="fin-dash__muted">{l.onFile ? `drops off ${monthYear(l.dropsOff)}` : 'aged off'}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <h4 className="fin-dash__card-title">Every Report</h4>
        <div className="fin-dash__table-wrap">
          <table className="fin-dash__table credit-table credit-table--compact">
            <thead>
              <tr>
                <th>Pull</th>
                <th>Bureau</th>
                <th>Status</th>
                <th className="num">Limit</th>
                <th className="num">Balance</th>
                <th>Lates 30/60/90</th>
              </tr>
            </thead>
            <tbody>
              {[...a.records].reverse().map((r, i) => (
                <tr key={i} className="is-clickable" onClick={() => onReport(r.reportId)}>
                  <td>{fullDate(r.pulledOn)}</td>
                  <td>{BUREAU_LABEL[r.bureau]}</td>
                  <td title={r.statusText ?? ''}>{r.status ? statusLabel(r.status) : (r.statusText ?? '—')}</td>
                  <td className="num">{money(r.limit ?? r.highBalance)}</td>
                  <td className="num">{money(r.balance)}</td>
                  <td>
                    {r.lateCounts['30']}/{r.lateCounts['60']}/{r.lateCounts['90']}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DetailSheet>
    );
  }
  if (sheet.kind === 'report') {
    const r = data.reports.find((x) => x.id === sheet.id);
    if (!r) return null;
    const accts = data.accounts.filter((a) => a.records.some((x) => x.reportId === r.id));
    const del = () => {
      if (!window.confirm(`Remove the ${fullDate(r.pulledOn)} ${BUREAU_LABEL[r.bureau]} report from MikeOS? The PDF in Drive stays.`)) return;
      api.deleteCreditReport(r.id).then(() => {
        onClose();
        onChanged();
      });
    };
    return (
      <DetailSheet title={`${r.bureau === 'other' ? (r.source ?? 'Report') : BUREAU_LABEL[r.bureau]} · ${fullDate(r.pulledOn)}`} sub={r.source ?? ''} onClose={onClose}>
        <p>
          {r.accounts} accounts ({r.open} open) · {r.hardInquiries} hard inquiries · {r.lateMarks} late marks
          {r.scores.length ? ` · Score ${r.scores.map((sc) => `${sc.value}${sc.bureau && r.bureau === 'other' ? ` (${BUREAU_SHORT[sc.bureau]})` : ''}`).join(', ')}` : ''}
        </p>
        {r.unreadable && <p className="fin-dash__neg">This PDF couldn’t be read.</p>}
        {r.partial && <p className="fin-dash__neg">Only part of this PDF could be read — some accounts and inquiries may be missing here.</p>}
        {r.notes && <p className="fin-dash__muted">{r.notes}</p>}
        <p>
          {r.fileId && (
            <a className="btn btn--ghost btn--sm" href={driveFileUrl(r.fileId)} target="_blank" rel="noopener noreferrer">
              Open PDF
            </a>
          )}{' '}
          <button type="button" className="btn btn--ghost btn--sm" onClick={del}>
            Remove From MikeOS
          </button>
        </p>
        <ul className="credit-mini">
          {accts.map((a) => (
            <li key={a.key}>
              <button type="button" className="link-button" onClick={() => onAccount(a.key)}>
                {a.name}
              </button>
              <span className="fin-dash__muted">
                {kindLabel(a.kind)} · {monthYear(a.opened)}
              </span>
            </li>
          ))}
        </ul>
      </DetailSheet>
    );
  }
  if (sheet.kind === 'personal') {
    const block = (title: string, rows: { label: string; firstSeen: string; lastSeen: string; bureaus: CreditBureau[]; current?: boolean }[]) => (
      <>
        <h4 className="fin-dash__card-title">{title}</h4>
        <ul className="credit-mini">
          {rows.map((x) => (
            <li key={x.label}>
              <span>
                {x.label} <BureauDots have={x.bureaus} />
              </span>
              <span className="fin-dash__muted">
                {x.current ? 'Current · ' : ''}
                {monthYear(x.firstSeen)}–{monthYear(x.lastSeen)}
              </span>
            </li>
          ))}
        </ul>
      </>
    );
    return (
      <DetailSheet title="On File About You" sub="Seen on any report, first and last pull" onClose={onClose}>
        {block(
          'Names',
          data.names.map((n) => ({ ...n, label: n.name })),
        )}
        {block(
          'Addresses',
          data.addresses.map((a) => ({ ...a, label: a.address })),
        )}
        {block(
          'Employers',
          data.employers.map((e) => ({ ...e, label: e.name })),
        )}
      </DetailSheet>
    );
  }
  // metric sheets
  const open = data.accounts.filter((a) => a.status === 'open');
  const titles = { open: 'Open Accounts', age: 'Account Ages', cards: 'Cards & Limits', inquiries: 'Hard Inquiries', lates: 'Late Payments' } as const;
  let body: React.ReactNode = null;
  if (sheet.metric === 'open' || sheet.metric === 'age')
    body = <AccountTable rows={[...open].sort((a, b) => (sheet.metric === 'age' ? (a.opened ?? '').localeCompare(b.opened ?? '') : (b.balance ?? 0) - (a.balance ?? 0)))} onOpen={onAccount} />;
  if (sheet.metric === 'cards') {
    const cards = open.filter((a) => kindGroup(a.kind) === 'card' || a.type === 'revolving').sort((a, b) => (b.limit ?? 0) - (a.limit ?? 0));
    body = (
      <>
        <p>
          {money(s.revolvingBalance)} reported across {money(s.revolvingLimit)} of limits on the latest pull — balances are whatever the statement showed the day each lender reported, so they move
          month to month.
        </p>
        <ul className="credit-mini">
          {cards.map((a) => (
            <li key={a.key}>
              <button type="button" className="link-button" onClick={() => onAccount(a.key)}>
                {a.name}
              </button>
              <span>
                {money(a.balance)} / {money(a.limit)}
                {a.limit && a.balance !== null ? <span className="fin-dash__muted"> · {Math.round((a.balance / a.limit) * 100)}%</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </>
    );
  }
  if (sheet.metric === 'inquiries') {
    const rows = data.inquiries.filter((i) => i.type === 'hard' && i.onFile);
    body = rows.length ? (
      <ul className="credit-mini">
        {rows.map((i) => (
          <li key={i.key}>
            <span>
              {i.name} <BureauDots have={i.bureaus} />
            </span>
            <span className="fin-dash__muted">
              {fullDate(i.date)} · off {monthYear(i.dropsOff)}
            </span>
          </li>
        ))}
      </ul>
    ) : (
      <p>No hard inquiries in the last two years.</p>
    );
  }
  if (sheet.metric === 'lates') {
    const rows = data.accounts.flatMap((a) => a.lates.map((l) => ({ a, l }))).sort((x, y) => y.l.month.localeCompare(x.l.month));
    body = rows.length ? (
      <ul className="credit-mini">
        {rows.map(({ a, l }) => (
          <li key={`${a.key}${l.month}`}>
            <button type="button" className="link-button" onClick={() => onAccount(a.key)}>
              {a.name} · {l.days} days · {monthYear(l.month)}
            </button>
            <span className={l.onFile ? 'fin-dash__neg' : 'fin-dash__muted'}>{l.onFile ? `on file until ${monthYear(l.dropsOff)}` : 'aged off'}</span>
          </li>
        ))}
      </ul>
    ) : (
      <p>No late payments on any report.</p>
    );
  }
  return (
    <DetailSheet title={titles[sheet.metric]} sub={`Latest pull ${fullDate(s.latestPull)}`} onClose={onClose}>
      {body}
    </DetailSheet>
  );
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setErr(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setErr('That isn’t valid JSON.');
      return;
    }
    const list = Array.isArray(parsed) ? parsed : (parsed as { reports?: unknown[] })?.reports;
    if (!Array.isArray(list)) {
      setErr('Expected { "reports": [...] }.');
      return;
    }
    setBusy(true);
    try {
      await api.importCreditReports(list);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const onFile = (f: File | undefined) => f && f.text().then(setText);
  return (
    <DetailSheet title="Import Reports" sub="Paste or choose the JSON file — reports with the same date and bureau are replaced" onClose={onClose}>
      <input type="file" accept=".json,application/json" onChange={(e) => onFile(e.target.files?.[0])} />
      <textarea className="input credit-import__text" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder='{ "reports": [ … ] }' />
      {err && <p className="fin-dash__neg">{err}</p>}
      <button type="button" className="btn" disabled={busy || !text.trim()} onClick={run}>
        {busy ? 'Importing…' : 'Import'}
      </button>
    </DetailSheet>
  );
}

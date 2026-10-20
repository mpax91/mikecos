import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { CareerBucket, CareerCheckView, CareerEmployerView, CareerEventView, CareerResponse, CareerStub, CareerYearView } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';
import { FinanceLineChart } from '../components/FinanceLineChart';
import { DashTitle, InfoTip } from '../components/dash/InfoTip';
import { DetailSheet } from '../components/dash/DetailSheet';
import { SectionPicker } from '../components/dash/SectionPicker';
import { KebabMenu } from '../components/KebabMenu';

/** Finance → Career (Mike, 2026-10-20): a career earnings tracker from the
 * paystubs and equity documents in Mike's per-employer Drive folders
 * (worker/src/career/). Timeline, earnings by year (paystubs, else W-2s
 * from Taxes, else the Social Security record), pay history with raises and
 * job-change jumps, every paycheck, equity payouts, and rule-based checks. */

type Tab = 'overview' | 'years' | 'pay' | 'paychecks' | 'equity' | 'files';
const TABS: [Tab, string][] = [
  ['overview', 'Overview'],
  ['years', 'Years'],
  ['pay', 'Pay History'],
  ['paychecks', 'Paychecks'],
  ['equity', 'Equity'],
  ['files', 'Employers & Files'],
];
type Sheet =
  | { kind: 'year'; year: number }
  | { kind: 'employer'; id: string }
  | { kind: 'stub'; id: string }
  | { kind: 'event'; id: string }
  | { kind: 'lifetime' }
  | { kind: 'salary' }
  | { kind: 'import' }
  | { kind: 'edit'; id: string }
  | null;

export const BUCKET_LABEL: Record<CareerBucket, string> = { base: 'Base Pay', bonus: 'Bonus', stipend: 'Stipends', severance: 'Severance', equity: 'Equity', other: 'Other' };
const BUCKET_COLOR: Record<CareerBucket, string> = { base: '#2A6FB0', bonus: '#C0662E', stipend: '#3A9D7A', severance: '#7A5BB5', equity: '#B5913A', other: '#8A8F98' };
const BUCKET_ORDER: CareerBucket[] = ['base', 'bonus', 'stipend', 'severance', 'equity', 'other'];
const EMP_COLORS = ['#2A6FB0', '#C0662E', '#3A9D7A', '#7A5BB5', '#B5913A', '#C2457A', '#4C8C9E', '#8A6B4E', '#5B7F2E', '#6B6FC2'];
const KIND_LABEL: Record<string, string> = { regular: 'Paycheck', bonus: 'Bonus', stipend: 'Stipend', severance: 'Severance', equity: 'Equity', other: 'Other' };
const EVENT_LABEL: Record<string, string> = {
  share_sale: 'Shares Sold',
  acquisition_payout: 'Acquisition Payout',
  escrow_release: 'Escrow Release',
  report: 'Report',
  option_grant: 'Option Grant',
  option_exercise: 'Option Exercise',
  rsu_vest: 'RSU Vest',
  other: 'Other',
};
const FILE_STATUS: Record<string, string> = {
  loaded: 'Loaded',
  read: 'Read by MikeOS',
  imported: 'Imported',
  duplicate: 'Duplicate copy',
  not_read: 'Not read yet',
  queued: 'Queued',
  ignored: 'Not a PDF',
};

const money = (n: number | null | undefined) => (n == null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`);
const cents = (n: number | null | undefined) => (n == null ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const compact = (n: number) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1e4 ? `$${Math.round(n / 1000)}K` : money(n));
const fullDate = (iso: string | null | undefined) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—');
const monthYear = (iso: string | null | undefined) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'now');
const dateX = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const fmtYear = (ms: number) => String(new Date(ms).getUTCFullYear());
const tenure = (m: number | null) =>
  m == null ? '' : m < 12 ? `${Math.round(m)} mo` : `${Math.floor(m / 12)} yr${Math.floor(m / 12) === 1 ? '' : 's'}${Math.round(m % 12) ? ` ${Math.round(m % 12)} mo` : ''}`;
const FREQ: Record<number, string> = { 52: 'Weekly', 26: 'Every 2 weeks', 24: 'Twice a month', 12: 'Monthly' };

export function CareerPage() {
  useReportTabMeta('Career', 'finance');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<CareerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [scanning, setScanning] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .getCareer()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const scanNow = async (refind = false) => {
    setScanning('Checking Drive…');
    try {
      for (let pass = 0; pass < 12; pass++) {
        const r = await api.scanCareer(refind && pass === 0);
        setScanning(
          r.queued
            ? `Read ${r.read + r.imported} so far…`
            : `Checked ${r.listed} files in ${r.folders} folders${r.read + r.imported ? ` · loaded ${r.read + r.imported}` : ''}${r.notRead ? ` · ${r.notRead} not read yet` : ''}${r.error ? ` · ${r.error}` : ''}`,
        );
        if (!r.queued) break;
      }
    } catch (e) {
      setScanning(e instanceof Error ? e.message : String(e));
    }
    load();
  };

  const tab = (TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'overview') as Tab;
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t === 'overview') next.delete('tab');
    else next.set('tab', t);
    setParams(next, { replace: true });
  };
  const color = useMemo(() => {
    const m = new Map<string, string>();
    (data?.employers ?? []).forEach((e, i) => m.set(e.id, EMP_COLORS[i % EMP_COLORS.length]));
    return m;
  }, [data]);
  const name = useCallback((id: string) => data?.employers.find((e) => e.id === id)?.name ?? id, [data]);
  const unread = data?.drive.files.filter((f) => f.status === 'not_read') ?? [];
  const empty = data && !data.stubs.length && !data.years.length;

  return (
    <div className="finance-page career-page">
      <div className="breadcrumb">
        <button type="button" className="breadcrumb__back" onClick={() => navigate('/finance')} title="Back" aria-label="Back">
          ‹
        </button>
        <Link to="/finance" className="breadcrumb__link">
          Finance
        </Link>
        <span className="breadcrumb__sep">›</span>
        <span className="breadcrumb__current">Career</span>
      </div>

      <div className="links-page__header">
        <h1 className="heading-serif dash-title" style={{ fontSize: 24, margin: '0 0 2px' }}>
          Career
          <InfoTip label="About Career">
            <p>
              Every paystub, bonus, severance and equity payout from your employer folders in Drive (one folder per job, where they already are — copies are merged by file name), checked every night.
            </p>
            <p>
              Your current employer’s paystubs are read automatically. Older layouts were read once by Claude. Years with no paystubs are filled from the W-2s in Finance → Taxes, then from your Social
              Security record, so the line runs your whole career.
            </p>
            <p>Not tax advice. SSNs and account numbers are never stored.</p>
          </InfoTip>
        </h1>
        <KebabMenu
          items={[
            { label: 'Scan Drive Now', onClick: () => scanNow(false) },
            { label: 'Find Employer Folders Again', onClick: () => scanNow(true) },
            { label: 'Import Paystubs (JSON)…', onClick: () => setSheet({ kind: 'import' }) },
          ]}
        />
      </div>
      {data && data.totals.firstYear && (
        <p className="links-page__subhead">
          {data.employers.length} employers · {data.stubs.length} paystubs · {data.totals.firstYear}–{data.years.at(-1)?.year}
        </p>
      )}
      {scanning && <p className="credit-page__scan">{scanning}</p>}
      {unread.length > 0 && (
        <button type="button" className="credit-page__unread" onClick={() => setTab('files')}>
          ⚠ {unread.length} file(s) in your employer folders couldn’t be read automatically →
        </button>
      )}
      {error && <div className="empty-state">Couldn’t load Career: {error}</div>}
      {!data && !error && <div className="empty-state empty-state--section">Loading…</div>}
      {empty && (
        <div className="empty-state">
          Nothing loaded yet. Use ⋯ → Import Paystubs (JSON) with the file Claude made, then Scan Drive Now.
          <div style={{ marginTop: 10 }}>
            <button type="button" className="btn btn--sm" onClick={() => setSheet({ kind: 'import' })}>
              Import Paystubs
            </button>
          </div>
        </div>
      )}

      {data && !empty && (
        <>
          <SectionPicker options={TABS} value={tab} onChange={setTab} label="Section" className="credit-page__tabs" />
          {tab === 'overview' && <OverviewView data={data} color={color} name={name} open={setSheet} />}
          {tab === 'years' && <YearsView data={data} open={setSheet} />}
          {tab === 'pay' && <PayView data={data} color={color} name={name} open={setSheet} />}
          {tab === 'paychecks' && <PaychecksView data={data} name={name} open={setSheet} />}
          {tab === 'equity' && <EquityView data={data} name={name} open={setSheet} />}
          {tab === 'files' && <FilesView data={data} open={setSheet} onScan={() => scanNow(false)} />}
        </>
      )}

      {sheet && data && <SheetView sheet={sheet} data={data} color={color} name={name} open={setSheet} onClose={() => setSheet(null)} onDone={load} />}
      {sheet?.kind === 'import' && !data && <ImportSheet onClose={() => setSheet(null)} onDone={load} />}
    </div>
  );
}

type Open = (s: Sheet) => void;

function Tile({ label, value, sub, onClick }: { label: string; value: string; sub: string; onClick?: () => void }) {
  return (
    <button type="button" className="fin-dash__stat" onClick={onClick} disabled={!onClick}>
      <span className="fin-dash__stat-label">{label}</span>
      <span className="fin-dash__stat-value">{value}</span>
      <span className="fin-dash__stat-sub">{sub}</span>
    </button>
  );
}

function CheckRow({ c }: { c: CareerCheckView }) {
  return (
    <li className={`taxes-insight taxes-insight--${c.level}`}>
      <span className="taxes-insight__icon">{c.level === 'good' ? '✓' : c.level === 'warn' ? '⚠' : 'ⓘ'}</span>
      <span className="taxes-insight__body">
        <strong>{c.title}</strong>
        <span className="fin-dash__muted">{c.detail}</span>
      </span>
    </li>
  );
}

function OverviewView({ data, color, name, open }: { data: CareerResponse; color: Map<string, string>; name: (id: string) => string; open: Open }) {
  const [allChecks, setAllChecks] = useState(false);
  const t = data.totals;
  const cur = data.current;
  const curEmp = data.employers.find((e) => e.id === cur.employer) ?? null;
  const jumps = data.changes.filter((c) => c.kind === 'job_change');
  const avgJump = jumps.length ? jumps.reduce((s, c) => s + c.pct, 0) / jumps.length : null;
  return (
    <>
      <div className="fin-dash__stats fin-dash__stats--5">
        <Tile label="Career Earnings" value={compact(t.lifetime)} sub={`${t.years} years since ${t.firstYear}`} onClick={() => open({ kind: 'lifetime' })} />
        <Tile
          label="Best Year"
          value={t.bestYear ? compact(t.bestYear.total) : '—'}
          sub={t.bestYear ? String(t.bestYear.year) : ''}
          onClick={t.bestYear ? () => open({ kind: 'year', year: t.bestYear!.year }) : undefined}
        />
        <Tile
          label="Salary Now"
          value={t.currentSalary ? compact(t.currentSalary) : '—'}
          sub={t.startSalary && t.currentSalary ? `${(t.currentSalary / t.startSalary).toFixed(1)}× your first paystub salary` : ''}
          onClick={() => open({ kind: 'salary' })}
        />
        <Tile
          label="Pay Growth"
          value={t.cagr != null ? `${t.cagr}%/yr` : '—'}
          sub={avgJump != null ? `job changes averaged ${avgJump >= 0 ? '+' : ''}${avgJump.toFixed(0)}%` : 'compound, salary to salary'}
          onClick={() => open({ kind: 'salary' })}
        />
        <Tile
          label="Bonus · Severance · Equity"
          value={compact(t.bonus + t.severance + t.equityCash)}
          sub={`bonus ${compact(t.bonus)} · severance ${compact(t.severance)} · equity ${compact(t.equityCash)}`}
          onClick={() => open({ kind: 'lifetime' })}
        />
      </div>

      <div className="fin-dash__grid">
        {data.checks.length > 0 && (
          <section className="fin-dash__card fin-dash__card--full">
            <DashTitle
              info={
                <p>
                  Rule-based checks across your paystubs, the W-2s in Finance → Taxes and your Social Security record: extra Social Security withheld in years with two employers (refundable on your
                  1040), 401(k) over the yearly limit, paystubs vs W-2s, gaps between jobs, and a missing paycheck at your current job.
                </p>
              }
            >
              Things to Check
            </DashTitle>
            <ul className="taxes-insights">
              {(allChecks ? data.checks : data.checks.slice(0, 4)).map((c) => (
                <CheckRow key={c.id} c={c} />
              ))}
            </ul>
            {data.checks.length > 4 && (
              <button type="button" className="btn btn--ghost btn--sm taxes-insights__more" onClick={() => setAllChecks((v) => !v)}>
                {allChecks ? 'Show Fewer' : `Show ${data.checks.length - 4} More`}
              </button>
            )}
          </section>
        )}

        {curEmp && (
          <section className="fin-dash__card fin-dash__card--full">
            <DashTitle
              info={
                <p>
                  Your current job’s latest paystub and this year so far. The Social Security date is when this year’s withholding stops at your salary (the wage base) — paychecks get bigger after
                  that.
                </p>
              }
            >
              {curEmp.name} Now
            </DashTitle>
            {!cur.lastStub && (
              <p className="fin-dash__muted">
                Started {fullDate(curEmp.start)} — the first paystub shows up here once it’s saved in the “{curEmp.folderNames[0] ?? curEmp.name}” folder.
              </p>
            )}
            {cur.lastStub && (
              <div className="career-now">
                <button type="button" className="career-now__item" onClick={() => cur.lastStub && open({ kind: 'stub', id: cur.lastStub.id })}>
                  <span className="fin-dash__muted">Last paycheck</span>
                  <strong>{cur.lastStub ? cents(cur.lastStub.net) : '—'}</strong>
                  <span className="fin-dash__muted">{cur.lastStub ? `${fullDate(cur.lastStub.pay_date)} · ${cents(cur.lastStub.gross)} gross` : ''}</span>
                </button>
                <div className="career-now__item">
                  <span className="fin-dash__muted">This year so far</span>
                  <strong>{cur.ytd ? money(cur.ytd.gross) : '—'}</strong>
                  <span className="fin-dash__muted">{cur.ytd ? `${money(cur.ytd.net)} take-home · ${money(cur.ytd.taxes)} taxes` : ''}</span>
                </div>
                <div className="career-now__item">
                  <span className="fin-dash__muted">Salary</span>
                  <strong>{cur.annualSalary ? money(cur.annualSalary) : '—'}</strong>
                  <span className="fin-dash__muted">{curEmp.frequency ? (FREQ[curEmp.frequency] ?? '') : ''}</span>
                </div>
                <div className="career-now__item">
                  <span className="fin-dash__muted">Next paycheck</span>
                  <strong>{cur.nextPayDate ? fullDate(cur.nextPayDate) : '—'}</strong>
                  <span className="fin-dash__muted">{cur.ssMaxDate ? `Social Security stops ~${fullDate(cur.ssMaxDate)}` : ''}</span>
                </div>
              </div>
            )}
          </section>
        )}

        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle info={<p>Each job from its first to last paystub (or the dates you set in Employers &amp; Files). Gaps between bands are time between jobs. Tap a job for its totals.</p>}>
            Timeline
          </DashTitle>
          <Timeline data={data} color={color} open={open} />
        </section>

        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle
            info={
              <p>
                Gross pay each calendar year, split by kind. Faded bars are years without paystubs — those come from the W-2s in Finance → Taxes (box 1, a little under gross) or your Social Security
                record. Tap a year for the breakdown.
              </p>
            }
          >
            Earnings by Year
          </DashTitle>
          <YearBars years={data.years} open={open} />
          <Legend />
        </section>

        <section className="fin-dash__card fin-dash__card--wide">
          <DashTitle info={<p>Your salary as each paystub shows it (the pay rate, or base pay × paychecks a year). Each color is an employer.</p>}>Salary Over Time</DashTitle>
          <SalaryChart data={data} color={color} name={name} />
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>Total pay from each employer, paystubs plus equity cash.</p>}>By Employer</DashTitle>
          <ul className="ssa-bars">
            {[...data.employers]
              .sort((a, b) => b.totals.gross + b.equityCash - (a.totals.gross + a.equityCash))
              .map((e) => {
                const max = Math.max(...data.employers.map((x) => x.totals.gross + x.equityCash), 1);
                const v = e.totals.gross + e.equityCash;
                return (
                  <li key={e.id} className="career-click" onClick={() => open({ kind: 'employer', id: e.id })}>
                    <span className="ssa-bars__label career-bars__label">{e.name}</span>
                    <span className="ssa-bars__track">
                      <span className="ssa-bars__fill" style={{ width: `${(v / max) * 100}%`, background: color.get(e.id) }} />
                    </span>
                    <span className="ssa-bars__value">{compact(v)}</span>
                  </li>
                );
              })}
          </ul>
        </section>
      </div>
    </>
  );
}

function Legend() {
  return (
    <div className="career-legend">
      {BUCKET_ORDER.filter((b) => b !== 'other').map((b) => (
        <span key={b}>
          <i style={{ background: BUCKET_COLOR[b] }} />
          {BUCKET_LABEL[b]}
        </span>
      ))}
    </div>
  );
}

function Timeline({ data, color, open }: { data: CareerResponse; color: Map<string, string>; open: Open }) {
  const emps = data.employers.filter((e) => e.start);
  if (!emps.length) return <p className="fin-dash__muted">No dates yet.</p>;
  const today = new Date().toISOString().slice(0, 10);
  const minX = Math.min(...emps.map((e) => dateX(e.start!)));
  const maxX = Math.max(...emps.map((e) => dateX(e.end ?? today)));
  const W = 760;
  const rowH = 26;
  const pad = { l: 8, r: 8, t: 6, b: 22 };
  const H = pad.t + emps.length * rowH + pad.b;
  const sx = (ms: number) => pad.l + ((ms - minX) / Math.max(1, maxX - minX)) * (W - pad.l - pad.r);
  const y0 = new Date(minX).getUTCFullYear();
  const y1 = new Date(maxX).getUTCFullYear();
  const step = Math.max(1, Math.ceil((y1 - y0) / 10));
  return (
    <>
      <ul className="career-timeline-list">
        {emps.map((e) => (
          <li key={e.id} className="career-click" onClick={() => open({ kind: 'employer', id: e.id })}>
            <i className="career-dot" style={{ background: color.get(e.id) }} />
            <strong>{e.name}</strong>
            <span className="fin-dash__muted">
              {monthYear(e.start)} – {e.isCurrent ? 'now' : monthYear(e.end)} · {tenure(e.months)}
            </span>
          </li>
        ))}
      </ul>
      <svg className="career-timeline" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Employers over time">
        {Array.from({ length: y1 - y0 + 1 }, (_, i) => y0 + i)
          .filter((y) => (y - y0) % step === 0 && Date.UTC(y, 0, 1) >= minX)
          .map((y) => (
            <g key={y}>
              <line x1={sx(Date.UTC(y, 0, 1))} x2={sx(Date.UTC(y, 0, 1))} y1={pad.t} y2={H - pad.b} stroke="var(--color-border)" />
              <text x={sx(Date.UTC(y, 0, 1))} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--color-muted)">
                {y}
              </text>
            </g>
          ))}
        {emps.map((e, i) => {
          const x1 = sx(dateX(e.start!));
          const x2 = Math.max(x1 + 4, sx(dateX(e.end ?? today)));
          const y = pad.t + i * rowH;
          const labelRight = x2 + 6 + e.name.length * 6.2 < W;
          return (
            <g key={e.id} className="career-click" onClick={() => open({ kind: 'employer', id: e.id })}>
              <title>{`${e.name}: ${monthYear(e.start)} – ${monthYear(e.end)} (${tenure(e.months)})`}</title>
              <rect x={x1} y={y + 4} width={x2 - x1} height={rowH - 8} rx={4} fill={color.get(e.id)} opacity={e.isCurrent ? 1 : 0.85} />
              <text x={labelRight ? x2 + 6 : x1 - 6} y={y + rowH / 2 + 4} textAnchor={labelRight ? 'start' : 'end'} fontSize={12} fill="var(--color-ink)">
                {e.name}
              </text>
            </g>
          );
        })}
      </svg>
    </>
  );
}

function YearBars({ years, open }: { years: CareerYearView[]; open: Open }) {
  if (!years.length) return null;
  const W = 760;
  const H = 230;
  const pad = { l: 48, r: 8, t: 10, b: 24 };
  const max = Math.max(...years.map((y) => y.total), 1);
  const bw = (W - pad.l - pad.r) / years.length;
  const sy = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const every = Math.ceil(years.length / 12);
  return (
    <svg className="ssa-earn__chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Earnings by year">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={W - pad.r} y1={sy(t)} y2={sy(t)} stroke="var(--color-border)" />
          <text x={pad.l - 6} y={sy(t) + 4} textAnchor="end" fontSize={11} fill="var(--color-muted)">
            {compact(t)}
          </text>
        </g>
      ))}
      {years.map((y, i) => {
        const x = pad.l + i * bw;
        let acc = 0;
        const faded = y.source === 'w2' || y.source === 'ssa';
        return (
          <g key={y.year} className="ssa-earn__bar" onClick={() => open({ kind: 'year', year: y.year })}>
            <title>{`${y.year}: ${money(y.total)}${faded ? ` (from ${y.source === 'w2' ? 'W-2s' : 'Social Security record'})` : ''}`}</title>
            <rect x={x} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" />
            {BUCKET_ORDER.map((b) => {
              const v = y.buckets[b];
              if (v <= 0) return null;
              const top = sy(acc + v);
              const h = sy(acc) - top;
              acc += v;
              return <rect key={b} x={x + bw * 0.14} y={top} width={bw * 0.72} height={Math.max(0, h)} fill={BUCKET_COLOR[b]} opacity={faded ? 0.35 : 1} />;
            })}
            {i % every === 0 && (
              <text x={x + bw / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--color-muted)">
                {y.year}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function SalaryChart({ data, color, name }: { data: CareerResponse; color: Map<string, string>; name: (id: string) => string }) {
  const series = data.employers
    .map((e) => {
      const pts = data.salary.filter((p) => p.employer === e.id).map((p) => ({ x: dateX(p.date), y: p.annual }));
      if (pts.length && e.lastStub) pts.push({ x: dateX(e.isCurrent ? new Date().toISOString().slice(0, 10) : e.lastStub), y: pts[pts.length - 1].y });
      return { name: name(e.id), color: color.get(e.id) ?? '#888', points: pts, step: true };
    })
    .filter((s) => s.points.length);
  if (!series.length) return <p className="fin-dash__muted">No salary figures on the paystubs yet.</p>;
  return <FinanceLineChart ariaLabel="Salary over time" formatX={fmtYear} formatY={(v) => compact(v)} series={series} yFromZero={false} />;
}

function YearsView({ data, open }: { data: CareerResponse; open: Open }) {
  const years = [...data.years].reverse();
  const src = (y: CareerYearView) => (y.source === 'paystubs' ? `${y.stubs} paystubs` : y.source === 'mixed' ? `${y.stubs} paystubs + W-2s` : y.source === 'w2' ? 'W-2s' : 'Social Security record');
  return (
    <div className="fin-dash__grid">
      <section className="fin-dash__card fin-dash__card--full">
        <DashTitle info={<p>Gross pay by calendar year (pay date). Years with no paystubs come from W-2s (box 1) or the Social Security record. Equity is cash paid outside payroll.</p>}>
          Every Year
        </DashTitle>
        <div className="fin-dash__table-wrap post-table">
          <table className="fin-dash__table">
            <thead>
              <tr>
                <th>Year</th>
                <th className="rewards__num">Total</th>
                <th className="rewards__num">Base</th>
                <th className="rewards__num">Bonus</th>
                <th className="rewards__num">Other</th>
                <th className="rewards__num">Take-Home</th>
                <th>Employers</th>
                <th>From</th>
              </tr>
            </thead>
            <tbody>
              {years.map((y) => (
                <tr key={y.year} className="ssa-earn__row" onClick={() => open({ kind: 'year', year: y.year })}>
                  <td>{y.year}</td>
                  <td className="rewards__num">
                    <strong>{money(y.total)}</strong>
                  </td>
                  <td className="rewards__num">{money(y.buckets.base)}</td>
                  <td className="rewards__num">{y.buckets.bonus ? money(y.buckets.bonus) : ''}</td>
                  <td className="rewards__num">
                    {y.buckets.stipend + y.buckets.severance + y.buckets.equity + y.buckets.other ? money(y.buckets.stipend + y.buckets.severance + y.buckets.equity + y.buckets.other) : ''}
                  </td>
                  <td className="rewards__num">{y.net != null ? money(y.net) : ''}</td>
                  <td>{y.byEmployer.map((e) => e.name).join(', ')}</td>
                  <td className="fin-dash__muted">{src(y)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="post-cards">
          {years.map((y) => (
            <li key={y.year}>
              <button type="button" className="post-card" onClick={() => open({ kind: 'year', year: y.year })}>
                <span className="post-card__top">
                  <strong>{y.year}</strong>
                  <span className="fin-dash__muted">{y.byEmployer.map((e) => e.name).join(', ')}</span>
                </span>
                <span className="post-card__metrics">
                  <span className="post-card__metric">
                    <span className="post-card__metric-label">Total</span>
                    <span className="post-card__metric-value">{money(y.total)}</span>
                  </span>
                  <span className="post-card__metric">
                    <span className="post-card__metric-label">Bonus</span>
                    <span className="post-card__metric-value">{money(y.buckets.bonus)}</span>
                  </span>
                  <span className="post-card__metric">
                    <span className="post-card__metric-label">From</span>
                    <span className="post-card__metric-value">{src(y)}</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function PayView({ data, color, name, open }: { data: CareerResponse; color: Map<string, string>; name: (id: string) => string; open: Open }) {
  return (
    <div className="fin-dash__grid">
      <section className="fin-dash__card fin-dash__card--full">
        <DashTitle info={<p>Salary from each paystub (pay rate, or base pay × paychecks a year). Short first/last paychecks and one-off blips are smoothed out.</p>}>Salary Over Time</DashTitle>
        <SalaryChart data={data} color={color} name={name} />
      </section>
      <section className="fin-dash__card fin-dash__card--full">
        <DashTitle
          info={
            <p>
              Every change in salary: raises within a job, and the jump (or drop) from one job’s last salary to the next job’s first. Gap = days between the last paystub at one job and the first at
              the next.
            </p>
          }
        >
          Raises &amp; Job Changes
        </DashTitle>
        {!data.changes.length && <p className="fin-dash__muted">No changes found yet.</p>}
        <ul className="credit-mini career-changes">
          {[...data.changes].reverse().map((c) => (
            <li key={`${c.date}-${c.employer}`} className="career-click" onClick={() => open({ kind: 'employer', id: c.employer })}>
              <span>
                <strong>{c.kind === 'job_change' ? `→ ${name(c.employer)}` : c.kind === 'raise' ? `Raise at ${name(c.employer)}` : `Pay cut at ${name(c.employer)}`}</strong>
                <span className="fin-dash__muted"> · {fullDate(c.date)}</span>
              </span>
              <span>
                {money(c.from)} → {money(c.to)}{' '}
                <span className={c.pct >= 0 ? 'fin-dash__pos' : 'fin-dash__neg'}>
                  {c.pct >= 0 ? '+' : ''}
                  {c.pct}%
                </span>
                {c.gapDays != null && c.gapDays > 20 && <span className="fin-dash__muted"> · {Math.round(c.gapDays / 7)} wk gap</span>}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section className="fin-dash__card fin-dash__card--full">
        <DashTitle info={<p>Salary at the start and end of each job.</p>}>Each Job</DashTitle>
        <div className="fin-dash__table-wrap">
          <table className="fin-dash__table">
            <thead>
              <tr>
                <th>Employer</th>
                <th>When</th>
                <th className="rewards__num">Start Salary</th>
                <th className="rewards__num">End Salary</th>
                <th className="rewards__num">Change</th>
              </tr>
            </thead>
            <tbody>
              {data.employers.map((e) => (
                <tr key={e.id} className="ssa-earn__row" onClick={() => open({ kind: 'employer', id: e.id })}>
                  <td>
                    <i className="career-dot" style={{ background: color.get(e.id) }} />
                    {e.name}
                  </td>
                  <td className="fin-dash__muted">
                    {monthYear(e.start)} – {e.isCurrent ? 'now' : monthYear(e.end)}
                  </td>
                  <td className="rewards__num">{money(e.startSalary)}</td>
                  <td className="rewards__num">{money(e.endSalary)}</td>
                  <td className="rewards__num">
                    {e.startSalary && e.endSalary && e.endSalary !== e.startSalary ? `${e.endSalary > e.startSalary ? '+' : ''}${Math.round((e.endSalary / e.startSalary - 1) * 100)}%` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function PaychecksView({ data, name, open }: { data: CareerResponse; name: (id: string) => string; open: Open }) {
  const [emp, setEmp] = useState<string>('all');
  const [kind, setKind] = useState<string>('all');
  const stubs = [...data.stubs].reverse().filter((s) => (emp === 'all' || s.employer === emp) && (kind === 'all' || s.kind === kind));
  const [limit, setLimit] = useState(60);
  return (
    <div className="fin-dash__grid">
      <section className="fin-dash__card fin-dash__card--full">
        <div className="career-filters">
          <select className="input" value={emp} onChange={(e) => setEmp(e.target.value)}>
            <option value="all">All Employers</option>
            {data.employers.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="all">All Kinds</option>
            {Object.entries(KIND_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <span className="fin-dash__muted">
            {stubs.length} · {money(stubs.reduce((t, s) => t + s.gross, 0))} gross
          </span>
        </div>
        <div className="fin-dash__table-wrap post-table">
          <table className="fin-dash__table">
            <thead>
              <tr>
                <th>Pay Date</th>
                <th>Employer</th>
                <th>Kind</th>
                <th className="rewards__num">Gross</th>
                <th className="rewards__num">Taxes</th>
                <th className="rewards__num">Take-Home</th>
              </tr>
            </thead>
            <tbody>
              {stubs.slice(0, limit).map((s) => (
                <tr key={s.id} className="ssa-earn__row" onClick={() => open({ kind: 'stub', id: s.id })}>
                  <td>{fullDate(s.pay_date)}</td>
                  <td>{name(s.employer)}</td>
                  <td>{s.kind === 'regular' ? '' : <span className={`career-chip career-chip--${s.kind}`}>{KIND_LABEL[s.kind]}</span>}</td>
                  <td className="rewards__num">{cents(s.gross)}</td>
                  <td className="rewards__num">{cents(s.taxes_total)}</td>
                  <td className="rewards__num">{cents(s.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="post-cards">
          {stubs.slice(0, limit).map((s) => (
            <li key={s.id}>
              <button type="button" className="post-card" onClick={() => open({ kind: 'stub', id: s.id })}>
                <span className="post-card__top">
                  <strong>{fullDate(s.pay_date)}</strong>
                  <span className="fin-dash__muted">
                    {name(s.employer)}
                    {s.kind !== 'regular' ? ` · ${KIND_LABEL[s.kind]}` : ''}
                  </span>
                </span>
                <span className="post-card__metrics">
                  <span className="post-card__metric">
                    <span className="post-card__metric-label">Gross</span>
                    <span className="post-card__metric-value">{cents(s.gross)}</span>
                  </span>
                  <span className="post-card__metric">
                    <span className="post-card__metric-label">Take-Home</span>
                    <span className="post-card__metric-value">{cents(s.net)}</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {stubs.length > limit && (
          <button type="button" className="btn btn--ghost btn--sm taxes-insights__more" onClick={() => setLimit((l) => l + 120)}>
            Show More
          </button>
        )}
      </section>
    </div>
  );
}

function EquityView({ data, name, open }: { data: CareerResponse; name: (id: string) => string; open: Open }) {
  const ev = [...data.events].reverse();
  const stubEquity = data.stubs.filter((s) => s.kind === 'equity' || s.earnings.some((l) => l.kind === 'equity' && l.current));
  const cash = data.events.filter((e) => !e.via_payroll && e.kind !== 'report' && e.kind !== 'option_grant');
  const byEmp = new Map<string, number>();
  for (const e of cash) byEmp.set(e.employer, (byEmp.get(e.employer) ?? 0) + (e.gross ?? e.net ?? 0));
  return (
    <div className="fin-dash__grid">
      <div className="fin-dash__stats fin-dash__stats--5 fin-dash__card--full">
        <Tile label="Equity Cash" value={compact(data.totals.equityCash)} sub="paid outside payroll" />
        {[...byEmp.entries()].map(([id, v]) => (
          <Tile key={id} label={name(id)} value={compact(v)} sub={`${cash.filter((e) => e.employer === id).length} payment(s)`} />
        ))}
      </div>
      <section className="fin-dash__card fin-dash__card--full">
        <DashTitle
          info={
            <p>Share sales, acquisition payouts, escrow releases and the reports that track them, newest first. Payments that went through payroll are on the paystubs instead and counted there.</p>
          }
        >
          Equity &amp; Payouts
        </DashTitle>
        {!ev.length && <p className="fin-dash__muted">No equity documents loaded.</p>}
        <ul className="credit-mini career-changes">
          {ev.map((e) => (
            <li key={e.id} className="career-click" onClick={() => open({ kind: 'event', id: e.id })}>
              <span>
                <strong>{e.title}</strong>
                <span className="fin-dash__muted">
                  {' '}
                  · {name(e.employer)} · {fullDate(e.date)} · {EVENT_LABEL[e.kind] ?? e.kind}
                </span>
              </span>
              <span>{e.gross != null || e.net != null ? cents(e.gross ?? e.net) : e.remaining != null ? `${cents(e.remaining)} still held` : ''}</span>
            </li>
          ))}
        </ul>
      </section>
      {stubEquity.length > 0 && (
        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle info={<p>Equity that was paid or taxed through payroll.</p>}>Through Payroll</DashTitle>
          <ul className="credit-mini">
            {stubEquity.map((s) => (
              <li key={s.id} className="career-click" onClick={() => open({ kind: 'stub', id: s.id })}>
                <span>
                  {fullDate(s.pay_date)} · {name(s.employer)}
                </span>
                <span>{cents(s.gross)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function FilesView({ data, open, onScan }: { data: CareerResponse; open: Open; onScan: () => void }) {
  const d = data.drive;
  return (
    <div className="fin-dash__grid">
      <section className="fin-dash__card fin-dash__card--full">
        <DashTitle
          info={
            <p>
              MikeOS reads every folder named after an employer (both copies, where you have two) every night. Name files “Employer - YYYY.MM.DD.pdf”, adding “ - Bonus”, “ - Severance”, “ - Stipend”
              for one-off payments. Your current employer’s paystubs are read automatically; anything else shows Not read yet — ask Claude in this Project to read it, and the .json it saves in the
              folder is picked up.
            </p>
          }
        >
          Employers
        </DashTitle>
        <p className="fin-dash__muted">
          {d.lastScanAt ? `Checked ${new Date(d.lastScanAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Not checked yet'}
          {d.lastError ? ` · ${d.lastError}` : ''}{' '}
          <button type="button" className="btn btn--ghost btn--sm" onClick={onScan}>
            Scan Drive Now
          </button>
        </p>
        <ul className="career-emps">
          {data.employers.map((e) => {
            const folders = d.folders.filter((f) => f.employerId === e.id);
            const files = d.files.filter((f) => f.employerId === e.id);
            const bad = files.filter((f) => f.status === 'not_read');
            return (
              <li key={e.id}>
                <div className="career-emps__head">
                  <button type="button" className="career-emps__name" onClick={() => open({ kind: 'employer', id: e.id })}>
                    <strong>{e.name}</strong>
                  </button>
                  {e.isCurrent && <span className="career-chip career-chip--current">Current</span>}
                  <span className="fin-dash__muted">
                    {e.title ? `${e.title} · ` : ''}
                    {e.stubs} paystubs · {folders.length} folder{folders.length === 1 ? '' : 's'}
                    {folders.length === 0 ? ' (not found yet)' : ''}
                  </span>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => open({ kind: 'edit', id: e.id })}>
                    Edit
                  </button>
                </div>
                {folders.map((f) => (
                  <a key={f.folderId} className="career-emps__folder" href={f.url ?? '#'} target="_blank" rel="noopener noreferrer">
                    📁 {f.name}
                  </a>
                ))}
                {bad.length > 0 && (
                  <ul className="credit-mini">
                    {bad.map((f) => (
                      <li key={f.fileId}>
                        <a href={f.webUrl ?? '#'} target="_blank" rel="noopener noreferrer" className="fin-dash__neg">
                          {f.name}
                        </a>
                        <span className="fin-dash__muted">{f.error}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {files.length > 0 && (
                  <p className="fin-dash__muted career-emps__counts">
                    {Object.entries(
                      files.reduce<Record<string, number>>((m, f) => {
                        m[f.status] = (m[f.status] ?? 0) + 1;
                        return m;
                      }, {}),
                    )
                      .map(([s, n]) => `${n} ${FILE_STATUS[s] ?? s}`.toLowerCase())
                      .join(' · ')}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function SheetView({
  sheet,
  data,
  color,
  name,
  open,
  onClose,
  onDone,
}: {
  sheet: NonNullable<Sheet>;
  data: CareerResponse;
  color: Map<string, string>;
  name: (id: string) => string;
  open: Open;
  onClose: () => void;
  onDone: () => void;
}) {
  if (sheet.kind === 'import') return <ImportSheet onClose={onClose} onDone={onDone} />;
  if (sheet.kind === 'edit') {
    const e = data.employers.find((x) => x.id === sheet.id);
    return e ? <EditSheet e={e} onClose={onClose} onDone={onDone} /> : null;
  }
  if (sheet.kind === 'year') {
    const y = data.years.find((x) => x.year === sheet.year);
    if (!y) return null;
    const stubs = data.stubs.filter((s) => s.pay_date.startsWith(String(y.year)));
    return (
      <DetailSheet
        title={String(y.year)}
        sub={`${money(y.total)} · ${y.source === 'paystubs' ? `${y.stubs} paystubs` : y.source === 'mixed' ? 'paystubs + W-2s' : y.source === 'w2' ? 'from W-2s' : 'from the Social Security record'}`}
        onClose={onClose}
      >
        <ul className="ssa-bars">
          {BUCKET_ORDER.filter((b) => y.buckets[b] > 0).map((b) => (
            <li key={b}>
              <span className="ssa-bars__label career-bars__label">{BUCKET_LABEL[b]}</span>
              <span className="ssa-bars__track">
                <span className="ssa-bars__fill" style={{ width: `${(y.buckets[b] / y.total) * 100}%`, background: BUCKET_COLOR[b] }} />
              </span>
              <span className="ssa-bars__value">{money(y.buckets[b])}</span>
            </li>
          ))}
        </ul>
        <h4 className="career-sheet__h">Employers</h4>
        <ul className="credit-mini">
          {y.byEmployer.map((e) => (
            <li key={e.id}>
              <span>
                {e.name}
                {e.source === 'w2' ? <span className="fin-dash__muted"> · W-2</span> : e.partial ? <span className="fin-dash__muted"> · some paystubs missing (W-2 used for the total)</span> : null}
              </span>
              <span>{money(e.gross)}</span>
            </li>
          ))}
        </ul>
        {y.taxes && (
          <>
            <h4 className="career-sheet__h">Where It Went (paystubs)</h4>
            <ul className="credit-mini">
              <li>
                <span>Federal income tax</span>
                <span>{money(y.taxes.federal)}</span>
              </li>
              <li>
                <span>Social Security</span>
                <span>{money(y.taxes.socialSecurity)}</span>
              </li>
              <li>
                <span>Medicare</span>
                <span>{money(y.taxes.medicare)}</span>
              </li>
              <li>
                <span>State &amp; local (incl. SDI / family leave)</span>
                <span>{money(y.taxes.stateLocal)}</span>
              </li>
              {y.deductions && y.deductions.k401 > 0 && (
                <li>
                  <span>401(k)</span>
                  <span>{money(y.deductions.k401)}</span>
                </li>
              )}
              {y.deductions && y.deductions.health > 0 && (
                <li>
                  <span>Health, dental, vision, FSA/HSA</span>
                  <span>{money(y.deductions.health)}</span>
                </li>
              )}
              {y.deductions && y.deductions.other > 0 && (
                <li>
                  <span>Other deductions</span>
                  <span>{money(y.deductions.other)}</span>
                </li>
              )}
              <li>
                <strong>Take-home</strong>
                <strong>{money(y.net)}</strong>
              </li>
            </ul>
          </>
        )}
        <h4 className="career-sheet__h">Cross-Checks</h4>
        <ul className="credit-mini">
          <li>
            <span>W-2 wages on your return</span>
            <span>{money(y.w2)}</span>
          </li>
          <li>
            <span>Social Security record (Medicare wages)</span>
            <span>{money(y.ssa)}</span>
          </li>
        </ul>
        {stubs.length > 0 && <StubList stubs={stubs} name={name} open={open} />}
      </DetailSheet>
    );
  }
  if (sheet.kind === 'employer') {
    const e = data.employers.find((x) => x.id === sheet.id);
    if (!e) return null;
    const stubs = data.stubs.filter((s) => s.employer === e.id);
    const ev = data.events.filter((x) => x.employer === e.id);
    const pts = data.salary.filter((p) => p.employer === e.id);
    return (
      <DetailSheet title={e.name} sub={`${e.title ? `${e.title} · ` : ''}${monthYear(e.start)} – ${e.isCurrent ? 'now' : monthYear(e.end)} · ${tenure(e.months)}`} onClose={onClose}>
        <div className="career-now">
          <div className="career-now__item">
            <span className="fin-dash__muted">Total pay</span>
            <strong>{money(e.totals.gross + e.equityCash)}</strong>
            <span className="fin-dash__muted">{e.equityCash ? `incl. ${money(e.equityCash)} equity` : ''}</span>
          </div>
          <div className="career-now__item">
            <span className="fin-dash__muted">Salary</span>
            <strong>{e.endSalary ? money(e.endSalary) : '—'}</strong>
            <span className="fin-dash__muted">{e.startSalary && e.endSalary && e.startSalary !== e.endSalary ? `started at ${money(e.startSalary)}` : ''}</span>
          </div>
          <div className="career-now__item">
            <span className="fin-dash__muted">Bonus · Severance</span>
            <strong>{money(e.totals.bonus + e.totals.severance)}</strong>
            <span className="fin-dash__muted">{e.totals.severance ? `${money(e.totals.severance)} severance` : ''}</span>
          </div>
          <div className="career-now__item">
            <span className="fin-dash__muted">401(k)</span>
            <strong>{money(e.totals.k401)}</strong>
            <span className="fin-dash__muted">
              {e.frequency ? FREQ[e.frequency] : ''}
              {e.provider ? ` · ${e.provider}` : ''}
            </span>
          </div>
        </div>
        {pts.length > 1 && (
          <FinanceLineChart
            ariaLabel={`${e.name} salary`}
            formatX={fmtYear}
            formatY={(v) => compact(v)}
            yFromZero={false}
            series={[{ name: e.name, color: color.get(e.id) ?? '#888', points: pts.map((p) => ({ x: dateX(p.date), y: p.annual })), step: true }]}
          />
        )}
        {e.aliases.length > 0 && <p className="fin-dash__muted">Also known as {e.aliases.join(', ')}.</p>}
        {e.notes && <p className="fin-dash__muted">{e.notes}</p>}
        {ev.length > 0 && (
          <>
            <h4 className="career-sheet__h">Equity</h4>
            <ul className="credit-mini">
              {ev.map((x) => (
                <li key={x.id} className="career-click" onClick={() => open({ kind: 'event', id: x.id })}>
                  <span>
                    {fullDate(x.date)} · {x.title}
                  </span>
                  <span>{x.gross != null || x.net != null ? cents(x.gross ?? x.net) : ''}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <StubList stubs={stubs} name={name} open={open} />
      </DetailSheet>
    );
  }
  if (sheet.kind === 'stub') {
    const s = data.stubs.find((x) => x.id === sheet.id);
    return s ? <StubSheet s={s} name={name} onClose={onClose} onDone={onDone} /> : null;
  }
  if (sheet.kind === 'event') {
    const e = data.events.find((x) => x.id === sheet.id);
    return e ? <EventSheet e={e} name={name} onClose={onClose} /> : null;
  }
  if (sheet.kind === 'salary') {
    return (
      <DetailSheet title="Salary Over Time" sub={data.totals.cagr != null ? `${data.totals.cagr}% a year, compounded` : ''} onClose={onClose}>
        <SalaryChart data={data} color={color} name={name} />
        <ul className="credit-mini">
          {[...data.salary].reverse().map((p) => (
            <li key={`${p.date}-${p.employer}`}>
              <span>
                {fullDate(p.date)} · {name(p.employer)}
              </span>
              <span>{money(p.annual)}</span>
            </li>
          ))}
        </ul>
      </DetailSheet>
    );
  }
  // lifetime
  const t = data.totals;
  const allBuckets = BUCKET_ORDER.map((b) => [b, data.years.reduce((s, y) => s + y.buckets[b], 0)] as const).filter(([, v]) => v > 0);
  return (
    <DetailSheet title="Career Earnings" sub={`${money(t.lifetime)} since ${t.firstYear}`} onClose={onClose}>
      <YearBars years={data.years} open={open} />
      <ul className="ssa-bars">
        {allBuckets.map(([b, v]) => (
          <li key={b}>
            <span className="ssa-bars__label career-bars__label">{BUCKET_LABEL[b]}</span>
            <span className="ssa-bars__track">
              <span className="ssa-bars__fill" style={{ width: `${(v / t.lifetime) * 100}%`, background: BUCKET_COLOR[b] }} />
            </span>
            <span className="ssa-bars__value">{compact(v)}</span>
          </li>
        ))}
      </ul>
      <p className="fin-dash__note">Gross pay before taxes. Years without paystubs use W-2 wages (box 1, after pre-tax deductions) or the Social Security record, so early years run slightly low.</p>
    </DetailSheet>
  );
}

function StubList({ stubs, name, open }: { stubs: CareerStub[]; name: (id: string) => string; open: Open }) {
  const [all, setAll] = useState(false);
  const list = [...stubs].reverse();
  return (
    <>
      <h4 className="career-sheet__h">Paystubs ({stubs.length})</h4>
      <ul className="credit-mini">
        {(all ? list : list.slice(0, 12)).map((s) => (
          <li key={s.id} className="career-click" onClick={() => open({ kind: 'stub', id: s.id })}>
            <span>
              {fullDate(s.pay_date)}
              {s.kind !== 'regular' ? <span className={`career-chip career-chip--${s.kind}`}>{KIND_LABEL[s.kind]}</span> : null}
              <span className="fin-dash__muted"> · {name(s.employer)}</span>
            </span>
            <span>{cents(s.gross)}</span>
          </li>
        ))}
      </ul>
      {list.length > 12 && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAll((v) => !v)}>
          {all ? 'Show Fewer' : `Show All ${list.length}`}
        </button>
      )}
    </>
  );
}

function Lines({ title, lines, rateHours }: { title: string; lines: { label: string; current: number; ytd: number | null; rate?: number | null; hours?: number | null }[]; rateHours?: boolean }) {
  if (!lines.length) return null;
  return (
    <>
      <h4 className="career-sheet__h">{title}</h4>
      <table className="fin-dash__table career-lines">
        <thead>
          <tr>
            <th />
            {rateHours && <th className="rewards__num">Rate</th>}
            {rateHours && <th className="rewards__num">Hours</th>}
            <th className="rewards__num">This Check</th>
            <th className="rewards__num">Year to Date</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>{l.label}</td>
              {rateHours && <td className="rewards__num">{l.rate != null ? cents(l.rate) : ''}</td>}
              {rateHours && <td className="rewards__num">{l.hours ?? ''}</td>}
              <td className="rewards__num">{cents(l.current)}</td>
              <td className="rewards__num">{l.ytd != null ? cents(l.ytd) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function StubSheet({ s, name, onClose, onDone }: { s: CareerStub; name: (id: string) => string; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const pre = s.deductions.filter((d) => d.pre_tax);
  const post = s.deductions.filter((d) => !d.pre_tax);
  const del = async () => {
    if (!window.confirm('Remove this paystub from MikeOS? (The PDF stays in Drive and is read again on the next scan if MikeOS can read it.)')) return;
    setBusy(true);
    try {
      await api.deleteCareerStub(s.id);
      onDone();
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <DetailSheet
      title={`${name(s.employer)} · ${fullDate(s.pay_date)}`}
      sub={`${KIND_LABEL[s.kind]}${s.period_start ? ` · ${fullDate(s.period_start)} – ${fullDate(s.period_end)}` : ''}${s.provider ? ` · ${s.provider}` : ''}`}
      onClose={onClose}
    >
      <div className="career-now">
        <div className="career-now__item">
          <span className="fin-dash__muted">Gross</span>
          <strong>{cents(s.gross)}</strong>
        </div>
        <div className="career-now__item">
          <span className="fin-dash__muted">Taxes</span>
          <strong>{cents(s.taxes_total)}</strong>
        </div>
        <div className="career-now__item">
          <span className="fin-dash__muted">Deductions</span>
          <strong>{cents((s.pre_tax_total ?? 0) + (s.post_tax_total ?? 0))}</strong>
        </div>
        <div className="career-now__item">
          <span className="fin-dash__muted">Take-home</span>
          <strong>{cents(s.net)}</strong>
        </div>
      </div>
      {s.issues.length > 0 && <p className="fin-dash__neg">⚠ {s.issues.join(' · ')}</p>}
      <Lines title="Earnings" lines={s.earnings} rateHours={s.earnings.some((l) => l.rate != null || l.hours != null)} />
      <Lines title="Taxes" lines={s.taxes} />
      <Lines title="Before-Tax Deductions" lines={pre} />
      <Lines title="After-Tax Deductions" lines={post} />
      <Lines title="Employer Paid" lines={s.employer_contrib} />
      {s.ytd && (
        <p className="fin-dash__muted">
          Year to date: {cents(s.ytd.gross)} gross · {cents(s.ytd.taxes)} taxes · {cents(s.ytd.net)} take-home
        </p>
      )}
      <p className="career-sheet__actions">
        {s.file_id && (
          <a className="btn btn--sm" href={`https://drive.google.com/file/d/${s.file_id}/view`} target="_blank" rel="noopener noreferrer">
            Open PDF
          </a>
        )}
        <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={del}>
          Remove
        </button>
      </p>
    </DetailSheet>
  );
}

function EventSheet({ e, name, onClose }: { e: CareerEventView; name: (id: string) => string; onClose: () => void }) {
  return (
    <DetailSheet title={e.title} sub={`${name(e.employer)} · ${fullDate(e.date)} · ${EVENT_LABEL[e.kind] ?? e.kind}`} onClose={onClose}>
      <ul className="credit-mini">
        {e.gross != null && (
          <li>
            <span>Gross</span>
            <span>{cents(e.gross)}</span>
          </li>
        )}
        {e.net != null && (
          <li>
            <span>Net</span>
            <span>{cents(e.net)}</span>
          </li>
        )}
        {e.shares != null && (
          <li>
            <span>Shares</span>
            <span>{e.shares.toLocaleString('en-US')}</span>
          </li>
        )}
        {e.price != null && (
          <li>
            <span>Price per share</span>
            <span>{cents(e.price)}</span>
          </li>
        )}
        {e.remaining != null && (
          <li>
            <span>Still held back</span>
            <span>{cents(e.remaining)}</span>
          </li>
        )}
        <li>
          <span>Paid through payroll</span>
          <span>{e.via_payroll ? 'Yes (on a paystub)' : 'No'}</span>
        </li>
      </ul>
      {e.notes && <p className="fin-dash__muted">{e.notes}</p>}
      {e.file_id && (
        <a className="btn btn--sm" href={`https://drive.google.com/file/d/${e.file_id}/view`} target="_blank" rel="noopener noreferrer">
          Open PDF
        </a>
      )}
    </DetailSheet>
  );
}

function EditSheet({ e, onClose, onDone }: { e: CareerEmployerView; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({
    name: e.name,
    title: e.title ?? '',
    aliases: e.aliases.join(', '),
    folders: e.folderNames.join(', '),
    start: e.start ?? '',
    end: e.isCurrent ? '' : (e.end ?? ''),
    current: e.isCurrent,
    notes: e.notes ?? '',
  });
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    try {
      const split = (s: string) =>
        s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);
      await api.updateCareerEmployer(e.id, {
        name: form.name,
        title: form.title || null,
        aliases: split(form.aliases),
        folder_names: split(form.folders),
        start_date: form.start || null,
        end_date: form.current ? null : form.end || null,
        is_current: form.current,
        notes: form.notes || null,
      });
      onDone();
      onClose();
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    }
  };
  const field = (label: string, key: keyof typeof form, type = 'text', hint?: string) => (
    <label className="career-form__field">
      <span className="fin-dash__muted">{label}</span>
      <input className="input" type={type} value={String(form[key])} onChange={(ev) => setForm({ ...form, [key]: ev.target.value })} />
      {hint && <span className="fin-dash__muted career-form__hint">{hint}</span>}
    </label>
  );
  return (
    <DetailSheet title={`Edit ${e.name}`} sub="Dates left blank come from the first and last paystub" onClose={onClose}>
      <div className="career-form">
        {field('Name', 'name')}
        {field('Title / Role', 'title')}
        {field('Also Known As', 'aliases', 'text', 'Comma-separated — a rebrand or the legal name on the W-2')}
        {field('Drive Folder Names', 'folders', 'text', 'Comma-separated; every folder with one of these names is read')}
        {field('Started', 'start', 'date')}
        {!form.current && field('Left', 'end', 'date')}
        <label className="career-form__check">
          <input type="checkbox" checked={form.current} onChange={(ev) => setForm({ ...form, current: ev.target.checked })} /> Current employer
        </label>
        <label className="career-form__field">
          <span className="fin-dash__muted">Notes</span>
          <textarea className="input" rows={3} value={form.notes} onChange={(ev) => setForm({ ...form, notes: ev.target.value })} />
        </label>
        {err && <p className="fin-dash__neg">{err}</p>}
        <button type="button" className="btn" onClick={save}>
          Save
        </button>
      </div>
    </DetailSheet>
  );
}

function ImportSheet({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setErr(null);
    try {
      JSON.parse(text);
    } catch {
      setErr('That isn’t valid JSON.');
      return;
    }
    setBusy(true);
    try {
      await api.importCareer(text);
      onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <DetailSheet title="Import Paystubs" sub="Choose or paste the JSON Claude made — anything with the same id is replaced" onClose={onClose}>
      <input type="file" accept=".json,application/json" onChange={(e) => e.target.files?.[0]?.text().then(setText)} />
      <textarea
        className="input credit-import__text"
        rows={10}
        value={text.length > 20000 ? `${text.slice(0, 20000)}\n… (${Math.round(text.length / 1024)} KB loaded)` : text}
        onChange={(e) => setText(e.target.value)}
        placeholder='{ "employers": [ … ], "stubs": [ … ], "events": [ … ] }'
      />
      {err && <p className="fin-dash__neg">{err}</p>}
      <button type="button" className="btn" disabled={busy || !text.trim()} onClick={run}>
        {busy ? 'Importing…' : 'Import'}
      </button>
    </DetailSheet>
  );
}

/** Finance row data (FinancePage). */
export function careerRow(r: CareerResponse | null): { sub: string; value: string; value2: string } | null {
  if (!r || (!r.stubs.length && !r.years.length)) return null;
  const cur = r.employers.find((e) => e.isCurrent);
  return {
    sub: `${r.employers.length} employers · ${r.totals.firstYear}–${r.years.at(-1)?.year}${cur ? ` · now ${cur.name}` : ''}`,
    value: `${compact(r.totals.lifetime)} career`,
    value2: r.totals.currentSalary ? `Salary ${compact(r.totals.currentSalary)}${r.totals.cagr != null ? ` · ${r.totals.cagr}%/yr growth` : ''}` : '',
  };
}

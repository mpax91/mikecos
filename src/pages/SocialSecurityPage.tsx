import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { SocialSecurityResponse, SsaCheckView, SsaStatementView, SsaYearView } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';
import { FinanceLineChart } from '../components/FinanceLineChart';
import { DashTitle, InfoTip } from '../components/dash/InfoTip';
import { DetailSheet } from '../components/dash/DetailSheet';
import { SectionPicker } from '../components/dash/SectionPicker';
import { KebabMenu } from '../components/KebabMenu';

/** Finance → Social Security (Mike, 2026-10-19): the yearly "Your Social
 * Security Statement" PDFs from the Drive folder "Social Security", read by
 * the worker (worker/src/ssa/). Earnings record across statements, benefit
 * estimates over time, a what-if projection (stop working / start benefits)
 * done with SSA's own formula, and a savings-equivalent for net-worth
 * planning. Everything is in today's dollars, like the statement. */

type Tab = 'overview' | 'plan' | 'earnings' | 'statements';
const TABS: [Tab, string][] = [
  ['overview', 'Overview'],
  ['plan', 'Plan'],
  ['earnings', 'Earnings'],
  ['statements', 'Statements'],
];
type Sheet = { kind: 'age'; age: 'early' | 'fra' | 'late' } | { kind: 'worth' } | { kind: 'taxes' } | { kind: 'year'; year: number } | { kind: 'statement'; id: string } | { kind: 'import' } | null;

const C_EARLY = '#C0662E';
const C_FRA = '#2A6FB0';
const C_LATE = '#7A5BB5';
const WITHDRAWAL = 0.04; // 4% rule: $1 a year of income ≈ $25 saved
const SSA_LOGIN = 'https://www.ssa.gov/myaccount/';
const PLAN_KEY = 'mikeos.ssa.plan';

const money = (n: number | null | undefined) => (n == null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`);
const compact = (n: number) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1e4 ? `$${Math.round(n / 1000)}K` : money(n));
const fullDate = (iso: string | null | undefined) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—');
const dateX = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const fmtYear = (ms: number) => String(new Date(ms).getUTCFullYear());
const LAYOUT: Record<string, string> = { paper: 'Mailed paper statement (scan)', classic: 'Online statement (2016–21 layout)', chart2021: 'Online statement (Sep 2021 layout)', chart: 'Online statement' };

function readPlan(): { stop: number | null; claim: number | null } {
  try {
    const v = JSON.parse(localStorage.getItem(PLAN_KEY) ?? 'null') as { stop?: number; claim?: number } | null;
    return { stop: v?.stop ?? null, claim: v?.claim ?? null };
  } catch {
    return { stop: null, claim: null };
  }
}
function savePlan(p: { stop: number | null; claim: number | null }) {
  try {
    localStorage.setItem(PLAN_KEY, JSON.stringify(p));
  } catch {
    /* per-device convenience only */
  }
}

export function SocialSecurityPage() {
  useReportTabMeta('Social Security', 'finance');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<SocialSecurityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [scanning, setScanning] = useState<string | null>(null);
  const [allChecks, setAllChecks] = useState(false);

  const load = useCallback(() => {
    api
      .getSocialSecurity()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const scanNow = async () => {
    setScanning('Checking Drive…');
    try {
      for (let pass = 0; pass < 6; pass++) {
        const r = await api.scanSocialSecurity();
        if (r.error) {
          setScanning(r.error);
          break;
        }
        setScanning(r.queued ? `Read ${r.read + r.imported} so far…` : `Checked ${r.listed} files${r.read + r.imported ? ` · loaded ${r.read + r.imported}` : ''}${r.notRead ? ` · ${r.notRead} not read yet` : ''}`);
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

  const latest = data?.latest ?? null;
  const fra = latest?.fra_years ?? 67;
  const at = (age: number) => latest?.retirement[String(age)] ?? null;
  const prev = useMemo(() => {
    if (!data?.latest) return null;
    const y = data.latest.statement_date.slice(0, 4);
    return [...data.statements].reverse().find((s) => s.statement_date.slice(0, 4) < y) ?? null;
  }, [data]);
  const delta = (age: number) => {
    const a = prev?.retirement[String(age)];
    const b = at(age);
    return a && b ? b - a : null;
  };
  const unread = data?.drive.files.filter((f) => f.status === 'not_read') ?? [];

  return (
    <div className="finance-page ssa-page">
      <div className="breadcrumb">
        <button type="button" className="breadcrumb__back" onClick={() => navigate('/finance')} title="Back" aria-label="Back">
          ‹
        </button>
        <Link to="/finance" className="breadcrumb__link">
          Finance
        </Link>
        <span className="breadcrumb__sep">›</span>
        <span className="breadcrumb__current">Social Security</span>
      </div>

      <div className="links-page__header">
        <h1 className="heading-serif dash-title" style={{ fontSize: 24, margin: '0 0 2px' }}>
          Social Security
          <InfoTip label="About Social Security">
            <p>Your yearly “Your Social Security Statement” PDFs from the Drive folder “Social Security”, read automatically each night (the 2009–2010 mailed statements were scans, read once by Claude).</p>
            <p>
              All benefit amounts are monthly and in <strong>today’s dollars</strong>, like SSA’s own statement — Social Security adjusts for inflation, so compare them with today’s prices. The Plan tab uses
              SSA’s formula (best 35 years, wage-indexed); it reproduces every estimate on your statements to the dollar.
            </p>
            <p>Not financial advice. The SSN is never stored.</p>
          </InfoTip>
        </h1>
        <KebabMenu
          items={[
            { label: 'Scan Drive Now', onClick: scanNow },
            ...(data?.drive.folderUrl ? [{ label: 'Open Drive Folder', onClick: () => window.open(data.drive.folderUrl!, '_blank', 'noopener') }] : []),
            { label: 'my Social Security ↗', onClick: () => window.open(SSA_LOGIN, '_blank', 'noopener') },
            { label: 'Import Statement (JSON)…', onClick: () => setSheet({ kind: 'import' }) },
          ]}
        />
      </div>
      {data && latest && (
        <p className="links-page__subhead">
          {data.statements.length} statements · {data.statements[0].statement_date.slice(0, 4)}–{latest.statement_date.slice(0, 4)} · Latest {fullDate(latest.statement_date)} · next one goes on Today each April
        </p>
      )}
      {scanning && <p className="credit-page__scan">{scanning}</p>}
      {unread.length > 0 && (
        <button type="button" className="credit-page__unread" onClick={() => setTab('statements')}>
          ⚠ {unread.length} file(s) in the Drive folder couldn’t be read automatically →
        </button>
      )}
      {error && <div className="empty-state">Couldn’t load Social Security: {error}</div>}
      {!data && !error && <div className="empty-state empty-state--section">Loading…</div>}
      {data && !latest && (
        <div className="empty-state">
          No statements yet. Save your statement PDF to the Drive folder “Social Security” and use ⋯ → Scan Drive Now.
          <div style={{ marginTop: 10 }}>
            <button type="button" className="btn btn--sm" onClick={scanNow}>
              Scan Drive Now
            </button>
          </div>
        </div>
      )}

      {data && latest && (
        <>
          <SectionPicker options={TABS} value={tab} onChange={setTab} label="Section" className="credit-page__tabs" />

          {tab === 'overview' && (
            <>
              <div className="fin-dash__stats fin-dash__stats--5">
                <Tile label={`At ${fra} (Full)`} value={money(at(fra))} sub={deltaText(delta(fra), prev)} onClick={() => setSheet({ kind: 'age', age: 'fra' })} />
                <Tile label="At 70" value={money(at(70))} sub={at(70) && at(fra) ? `+${Math.round((at(70)! / at(fra)! - 1) * 100)}% for waiting` : ''} onClick={() => setSheet({ kind: 'age', age: 'late' })} />
                <Tile label="At 62" value={money(at(62))} sub={at(62) && at(fra) ? `${Math.round((1 - at(62)! / at(fra)!) * 100)}% less, for life` : ''} onClick={() => setSheet({ kind: 'age', age: 'early' })} />
                <Tile label="Worth in Savings" value={at(fra) ? compact((at(fra)! * 12) / WITHDRAWAL) : '—'} sub={`what ${money(at(fra))}/mo would take, invested`} onClick={() => setSheet({ kind: 'worth' })} />
                <Tile
                  label="Taxes Paid"
                  value={compact((data.totals.taxesYou ?? 0) + (data.totals.taxesEmployer ?? 0))}
                  sub={`you ${compact(data.totals.taxesYou ?? 0)} · employers ${compact(data.totals.taxesEmployer ?? 0)}`}
                  onClick={() => setSheet({ kind: 'taxes' })}
                />
              </div>

              <div className="fin-dash__grid">
                {data.checks.length > 0 && (
                  <section className="fin-dash__card fin-dash__card--full">
                    <DashTitle info={<p>Rule-based checks: your earnings record against your W-2s (Finance → Taxes), changes SSA made between statements, the best-35-years rule, the trust-fund outlook and survivor coverage.</p>}>
                      Things to Check
                    </DashTitle>
                    <ul className="taxes-insights">
                      {(allChecks ? data.checks : data.checks.slice(0, 5)).map((c) => (
                        <CheckRow key={c.key} c={c} />
                      ))}
                    </ul>
                    {data.checks.length > 5 && (
                      <button type="button" className="btn btn--ghost btn--sm taxes-insights__more" onClick={() => setAllChecks((v) => !v)}>
                        {allChecks ? 'Show Fewer' : `Show ${data.checks.length - 5} More`}
                      </button>
                    )}
                  </section>
                )}

                <section className="fin-dash__card fin-dash__card--wide">
                  <DashTitle info={<p>What each statement estimated, in that year’s dollars. Estimates rise as your record grows and wages grow nationally. The 2009–2010 statements assumed your earnings then (a lot lower).</p>}>
                    Estimates Over Time
                  </DashTitle>
                  <EstimatesChart data={data} fra={fra} />
                </section>

                <section className="fin-dash__card">
                  <DashTitle info={<p>Your newest statement’s monthly amount for each age you could start. Every month you wait raises it for life; “break-even” is how long you’d need to live for waiting to pay more in total.</p>}>
                    When You Start
                  </DashTitle>
                  <ClaimBars s={latest} fra={fra} />
                  {data.projection && (
                    <ul className="credit-mini ssa-breakeven">
                      {data.projection.breakEven
                        .filter((b) => b.age)
                        .map((b) => (
                          <li key={`${b.from}-${b.to}`}>
                            <span>
                              Waiting {b.from} → {b.to}
                            </span>
                            <span>pays off after age {b.age!.toFixed(1)}</span>
                          </li>
                        ))}
                    </ul>
                  )}
                </section>

                <section className="fin-dash__card fin-dash__card--full">
                  <DashTitle info={<p>What Social Security would pay your family if something happened this year, from your newest statement.</p>}>Disability &amp; Survivors</DashTitle>
                  <div className="ssa-cover">
                    <Cover label="If you became disabled" value={latest.disability} />
                    <Cover label="Minor child" value={latest.survivors.child} />
                    <Cover label="Spouse caring for a child under 16" value={latest.survivors.spouse_caring} />
                    <Cover label={`Spouse at full retirement age`} value={latest.survivors.spouse_fra} />
                    <Cover label="Family maximum" value={latest.survivors.family_max} />
                  </div>
                  {latest.death_benefit ? <p className="fin-dash__note">Plus a one-time death benefit of {money(latest.death_benefit)}.</p> : null}
                </section>
              </div>
            </>
          )}

          {tab === 'plan' && data.projection && <PlanView data={data} />}
          {tab === 'plan' && !data.projection && <div className="empty-state">The projection needs a statement that prints your date of birth.</div>}

          {tab === 'earnings' && <EarningsView data={data} onYear={(year) => setSheet({ kind: 'year', year })} />}

          {tab === 'statements' && <StatementsView data={data} onOpen={(id) => setSheet({ kind: 'statement', id })} onScan={scanNow} />}
        </>
      )}

      {sheet && data && <SheetView sheet={sheet} data={data} onClose={() => setSheet(null)} onDone={load} />}
    </div>
  );
}

function deltaText(d: number | null, prev: SsaStatementView | null): string {
  if (d == null || !prev) return '';
  return `${d >= 0 ? '+' : '−'}${money(Math.abs(d))} vs ${prev.statement_date.slice(0, 4)} statement`;
}

function Tile({ label, value, sub, onClick }: { label: string; value: string; sub: string; onClick: () => void }) {
  return (
    <button type="button" className="fin-dash__stat" onClick={onClick}>
      <span className="fin-dash__stat-label">{label}</span>
      <span className="fin-dash__stat-value">{value}</span>
      <span className="fin-dash__stat-sub">{sub}</span>
    </button>
  );
}

function CheckRow({ c }: { c: SsaCheckView }) {
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

function Cover({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="ssa-cover__item">
      <span className="fin-dash__muted">{label}</span>
      <strong>{value ? `${money(value)}/mo` : '—'}</strong>
    </div>
  );
}

function EstimatesChart({ data, fra }: { data: SocialSecurityResponse; fra: number }) {
  const pts = data.estimates.filter((e) => !e.sameAsPrevious);
  return (
    <FinanceLineChart
      ariaLabel="Monthly benefit estimates by statement"
      formatX={fmtYear}
      formatY={(v) => compact(v)}
      series={[
        { name: 'At 70', color: C_LATE, points: pts.filter((e) => e.at70).map((e) => ({ x: dateX(e.statement), y: e.at70! })) },
        { name: `At ${fra}`, color: C_FRA, points: pts.filter((e) => e.atFra).map((e) => ({ x: dateX(e.statement), y: e.atFra! })) },
        { name: 'At 62', color: C_EARLY, points: pts.filter((e) => e.at62).map((e) => ({ x: dateX(e.statement), y: e.at62! })) },
      ]}
    />
  );
}

function ClaimBars({ s, fra }: { s: SsaStatementView; fra: number }) {
  const ages = Object.keys(s.retirement)
    .map(Number)
    .sort((a, b) => a - b);
  const max = Math.max(...ages.map((a) => s.retirement[String(a)]));
  return (
    <ul className="ssa-bars">
      {ages.map((a) => {
        const v = s.retirement[String(a)];
        const color = a < fra ? C_EARLY : a === fra ? C_FRA : C_LATE;
        return (
          <li key={a}>
            <span className="ssa-bars__label">{a}</span>
            <span className="ssa-bars__track">
              <span className="ssa-bars__fill" style={{ width: `${(v / max) * 100}%`, background: color }} />
            </span>
            <span className="ssa-bars__value">{money(v)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function PlanView({ data }: { data: SocialSecurityResponse }) {
  const p = data.projection!;
  const saved = readPlan();
  const [stop, setStop] = useState<number>(saved.stop && p.stopAges.includes(saved.stop) ? saved.stop : p.fraYears);
  const [claim, setClaim] = useState<number>(saved.claim && p.claimAges.includes(saved.claim) ? saved.claim : p.fraYears);
  useEffect(() => savePlan({ stop, claim }), [stop, claim]);
  const cell = p.grid[String(stop)]?.[String(claim)];
  const monthly = cell?.monthly ?? 0;
  const base = p.grid[String(Math.min(claim, 70))]?.[String(claim)]?.monthly ?? p.grid[String(p.fraYears)]?.[String(p.fraYears)]?.monthly ?? 0;
  const tf = data.latest?.trust_fund ?? null;
  const calOk = p.calibration.filter((c) => c.ours === c.ssa).length;
  const stopNow = p.stopAges[0];
  return (
    <div className="fin-dash__grid">
      <section className="fin-dash__card fin-dash__card--full">
        <DashTitle
          info={
            <>
              <p>
                SSA’s formula with your real earnings record: your best 35 years, wage-indexed, through the year before you start. Until you stop working it assumes you keep earning about {money(p.future)} a
                year (the Social Security max, in today’s dollars — earnings above it don’t count).
              </p>
              <p>
                Checked against your {fullDate(data.latest!.statement_date)} statement: {calOk} of {p.calibration.length} ages match to the dollar. Today’s dollars; not advice.
              </p>
            </>
          }
        >
          What If
        </DashTitle>
        <div className="ssa-plan__controls">
          <label className="ssa-plan__field">
            <span className="fin-dash__muted">Stop working at</span>
            <select className="input" value={stop} onChange={(e) => setStop(Number(e.target.value))}>
              {p.stopAges.map((a) => (
                <option key={a} value={a}>
                  {a === stopNow ? `${a} (now)` : a}
                </option>
              ))}
            </select>
          </label>
          <label className="ssa-plan__field">
            <span className="fin-dash__muted">Start benefits at</span>
            <select className="input" value={claim} onChange={(e) => setClaim(Number(e.target.value))}>
              {p.claimAges.map((a) => (
                <option key={a} value={a}>
                  {a === p.fraYears ? `${a} (full)` : a}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="fin-dash__stats fin-dash__stats--5 ssa-plan__result">
          <div className="fin-dash__stat">
            <span className="fin-dash__stat-label">Monthly</span>
            <span className="fin-dash__stat-value">{money(monthly)}</span>
            <span className="fin-dash__stat-sub">{cell?.fromJanuary ? `${money(cell.fromJanuary)} from the next January` : `starting at ${claim}`}</span>
          </div>
          <div className="fin-dash__stat">
            <span className="fin-dash__stat-label">Yearly</span>
            <span className="fin-dash__stat-value">{compact(monthly * 12)}</span>
            <span className="fin-dash__stat-sub">today’s dollars, rises with inflation</span>
          </div>
          <div className="fin-dash__stat">
            <span className="fin-dash__stat-label">Worth in Savings</span>
            <span className="fin-dash__stat-value">{compact((monthly * 12) / WITHDRAWAL)}</span>
            <span className="fin-dash__stat-sub">nest egg you won’t need (4% rule)</span>
          </div>
          <div className="fin-dash__stat">
            <span className="fin-dash__stat-label">vs Working to {claim}</span>
            <span className="fin-dash__stat-value">{monthly - base === 0 ? '—' : `${monthly - base > 0 ? '+' : '−'}${money(Math.abs(monthly - base))}`}</span>
            <span className="fin-dash__stat-sub">{stop < claim ? `${claim - stop} fewer working years` : 'SSA’s own assumption'}</span>
          </div>
          {tf && (
            <div className="fin-dash__stat">
              <span className="fin-dash__stat-label">If Cut to {tf.pct}%</span>
              <span className="fin-dash__stat-value">{money((monthly * tf.pct) / 100)}</span>
              <span className="fin-dash__stat-sub">SSA’s outlook after {tf.year}</span>
            </div>
          )}
        </div>
      </section>

      <section className="fin-dash__card fin-dash__card--wide">
        <DashTitle info={<p>Your monthly benefit at {claim} depending on the last age you work. Each year at the max replaces one of your weaker (or $0) years in the best 35 — the line flattens once your early years are all replaced.</p>}>
          If You Stop Working At…
        </DashTitle>
        <FinanceLineChart
          ariaLabel={`Monthly benefit at ${claim} by the age you stop working`}
          formatX={(v) => String(Math.round(v))}
          formatY={(v) => compact(v)}
          yFromZero={false}
          series={[{ name: `Start at ${claim}`, color: C_FRA, points: p.stopAges.map((a) => ({ x: a, y: p.grid[String(a)][String(claim)].monthly })) }]}
        />
        <p className="fin-dash__note">
          Stopping now ({stopNow}) still pays {money(p.grid[String(stopNow)][String(claim)].monthly)}/mo at {claim}. Each more year at the max adds about {money(p.nextYearAdds)}/mo at {p.fraYears} right now
          {p.zeroYearsInTop35 ? ` (${p.zeroYearsInTop35} of your best 35 years are still $0)` : ''}.
        </p>
      </section>

      <section className="fin-dash__card">
        <DashTitle info={<p>Every start age for the stop-working age you picked. Waiting past {p.fraYears} adds 8% a year; credits earned in the year you start are added the next January.</p>}>
          Start Age, If You Stop at {stop}
        </DashTitle>
        <table className="fin-dash__table ssa-plan__table">
          <thead>
            <tr>
              <th>Start</th>
              <th className="rewards__num">Monthly</th>
              <th className="rewards__num">Yearly</th>
              <th className="rewards__num">In Savings</th>
            </tr>
          </thead>
          <tbody>
            {p.claimAges.map((a) => {
              const m = p.grid[String(stop)][String(a)].monthly;
              return (
                <tr key={a} className={a === claim ? 'ssa-plan__row--on' : ''} onClick={() => setClaim(a)}>
                  <td>{a === p.fraYears ? `${a} (full)` : a}</td>
                  <td className="rewards__num">{money(m)}</td>
                  <td className="rewards__num">{compact(m * 12)}</td>
                  <td className="rewards__num">{compact((m * 12) / WITHDRAWAL)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function EarningsView({ data, onYear }: { data: SocialSecurityResponse; onYear: (y: number) => void }) {
  const years = [...data.years].reverse();
  const t = data.totals;
  return (
    <div className="fin-dash__grid">
      <div className="fin-dash__stats fin-dash__stats--5 fin-dash__card--full ssa-earn__stats">
        <div className="fin-dash__stat">
          <span className="fin-dash__stat-label">Years Worked</span>
          <span className="fin-dash__stat-value">{t.yearsWorked}</span>
          <span className="fin-dash__stat-sub">of the 35 that count</span>
        </div>
        <div className="fin-dash__stat">
          <span className="fin-dash__stat-label">Years at the Max</span>
          <span className="fin-dash__stat-value">{t.yearsAtMax}</span>
          <span className="fin-dash__stat-sub">{t.maxStreak ? `every year since ${t.maxStreakFrom}` : 'none yet'}</span>
        </div>
        <div className="fin-dash__stat">
          <span className="fin-dash__stat-label">Taxed for Social Security</span>
          <span className="fin-dash__stat-value">{compact(t.ssEarnings)}</span>
          <span className="fin-dash__stat-sub">lifetime, as earned</span>
        </div>
        <div className="fin-dash__stat">
          <span className="fin-dash__stat-label">Taxed for Medicare</span>
          <span className="fin-dash__stat-value">{compact(t.medicareEarnings)}</span>
          <span className="fin-dash__stat-sub">all earnings (no cap)</span>
        </div>
        {data.projection && (
          <div className="fin-dash__stat">
            <span className="fin-dash__stat-label">Average Indexed (AIME)</span>
            <span className="fin-dash__stat-value">{money(data.projection.aime)}</span>
            <span className="fin-dash__stat-sub">a month, best 35, keep-maxing plan</span>
          </div>
        )}
      </div>

      <section className="fin-dash__card fin-dash__card--full">
        <DashTitle info={<p>Each year’s earnings taxed for Social Security (the bar) against that year’s maximum (the tick). Dark bars are the years that would still count among your best 35 if you keep earning at the max until full retirement age — every later max year pushes out a weaker early one. Tap a year for its history across statements.</p>}>
          Earnings Record
        </DashTitle>
        <EarningsBars years={data.years} onYear={onYear} />
      </section>

      <section className="fin-dash__card fin-dash__card--full">
        <DashTitle info={<p>SSA’s record, year by year (newest statement wins). “Today’s $” is the year wage-indexed the way SSA does it. W-2 = your wages from Finance → Taxes, for the cross-check (401(k) deferrals make Medicare earnings higher — that’s normal).</p>}>
          Every Year
        </DashTitle>
        <div className="fin-dash__table-wrap post-table">
          <table className="fin-dash__table">
            <thead>
              <tr>
                <th>Year</th>
                <th className="rewards__num">Social Security</th>
                <th className="rewards__num">Medicare</th>
                <th className="rewards__num">Today’s $</th>
                <th className="rewards__num">W-2 Wages</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {years.map((y) => (
                <tr key={y.year} onClick={() => onYear(y.year)} className="ssa-earn__row">
                  <td>{y.year}</td>
                  <td className="rewards__num">{money(y.ss)}</td>
                  <td className="rewards__num">{money(y.medicare)}</td>
                  <td className="rewards__num">{money(y.indexed)}</td>
                  <td className="rewards__num">{y.w2 != null ? money(y.w2) : ''}</td>
                  <td className="fin-dash__muted">{yearNotes(y).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="post-cards">
          {years.map((y) => (
            <li key={y.year}>
              <button type="button" className="post-card" onClick={() => onYear(y.year)}>
                <span className="post-card__top">
                  <strong>{y.year}</strong>
                  <span className="fin-dash__muted">{yearNotes(y).join(' · ')}</span>
                </span>
                <span className="post-card__metrics">
                  <span className="post-card__metric">
                    <span className="post-card__metric-label">Social Security</span>
                    <span className="post-card__metric-value">{money(y.ss)}</span>
                  </span>
                  <span className="post-card__metric">
                    <span className="post-card__metric-label">Medicare</span>
                    <span className="post-card__metric-value">{money(y.medicare)}</span>
                  </span>
                  <span className="post-card__metric">
                    <span className="post-card__metric-label">Today’s $</span>
                    <span className="post-card__metric-value">{money(y.indexed)}</span>
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

function yearNotes(y: SsaYearView): string[] {
  const n: string[] = [];
  if (y.atMax) n.push('At max');
  if (y.counted) n.push('Counts at 67');
  if (y.estimated) n.push('Spread from a range');
  const changed = y.history.some((h, i) => i > 0 && (h.ss !== y.history[i - 1].ss || h.medicare !== y.history[i - 1].medicare));
  if (changed) n.push('Changed');
  return n;
}

function EarningsBars({ years, onYear }: { years: SsaYearView[]; onYear: (y: number) => void }) {
  const W = 760;
  const H = 220;
  const pad = { l: 44, r: 8, t: 10, b: 24 };
  const max = Math.max(...years.map((y) => Math.max(y.ss, y.wageBase)));
  const bw = (W - pad.l - pad.r) / years.length;
  const sy = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, max / 2, max];
  return (
    <svg className="ssa-earn__chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Earnings taxed for Social Security by year">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={W - pad.r} y1={sy(t)} y2={sy(t)} stroke="var(--color-border)" strokeWidth={1} />
          <text x={pad.l - 6} y={sy(t) + 4} textAnchor="end" fontSize={11} fill="var(--color-muted)">
            {compact(t)}
          </text>
        </g>
      ))}
      {years.map((y, i) => {
        const x = pad.l + i * bw;
        return (
          <g key={y.year} className="ssa-earn__bar" onClick={() => onYear(y.year)}>
            <title>{`${y.year}: ${money(y.ss)} of ${money(y.wageBase)} max`}</title>
            <rect x={x} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" />
            <rect x={x + bw * 0.15} y={sy(y.ss)} width={bw * 0.7} height={Math.max(0, sy(0) - sy(y.ss))} fill={C_FRA} opacity={y.counted ? 1 : 0.35} rx={2} />
            <line x1={x + bw * 0.1} x2={x + bw * 0.9} y1={sy(y.wageBase)} y2={sy(y.wageBase)} stroke="var(--color-ink)" strokeWidth={1.5} opacity={0.55} />
            {(i % Math.ceil(years.length / 10) === 0 || (i === years.length - 1 && i % Math.ceil(years.length / 10) >= Math.ceil(years.length / 20))) && (
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

const FILE_STATUS: Record<string, string> = { loaded: 'Loaded', read: 'Read by MikeOS', imported: 'Imported', not_read: 'Not read yet', queued: 'Queued' };

function StatementsView({ data, onOpen, onScan }: { data: SocialSecurityResponse; onOpen: (id: string) => void; onScan: () => void }) {
  const d = data.drive;
  const files = d.files;
  return (
    <div className="fin-dash__grid">
      <section className="fin-dash__card fin-dash__card--full">
        <DashTitle info={<p>Newest first. Tap a statement for everything it printed and a link to the PDF.</p>}>Statements</DashTitle>
        <ul className="credit-mini">
          {[...data.statements].reverse().map((s) => (
            <li key={s.id}>
              <button type="button" className="link-button" onClick={() => onOpen(s.id)}>
                {fullDate(s.statement_date)}
              </button>
              <span className="fin-dash__muted">
                {s.fra_years ? `${money(s.retirement[String(s.fra_years)])} at ${s.fra_years}` : ''}
                {s.sameAsPrevious ? ' · same figures as the one before' : ''}
                {s.layout === 'paper' ? ' · paper scan' : ''}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section className="fin-dash__card fin-dash__card--full">
        <DashTitle
          info={
            <p>
              MikeOS checks the Drive folder “Social Security” every night. Name each PDF “SSA - YYYY.MM.DD.pdf”. Online statements are read automatically; a scan or a layout SSA hasn’t used before shows Not
              read yet — ask Claude to read it, and the .json file it saves in the folder is picked up the same way.
            </p>
          }
        >
          Drive Folder
        </DashTitle>
        <p className="fin-dash__muted">
          {d.folder ? `“${d.folder}”` : 'Not found yet'} · {d.lastScanAt ? `checked ${new Date(d.lastScanAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'not checked yet'}
          {d.lastError ? ` · ${d.lastError}` : ''}{' '}
          <button type="button" className="btn btn--ghost btn--sm" onClick={onScan}>
            Scan Drive Now
          </button>
        </p>
        <ul className="credit-mini">
          {files.map((f) => (
            <li key={f.fileId}>
              {f.webUrl ? (
                <a href={f.webUrl} target="_blank" rel="noopener noreferrer" className={f.status === 'not_read' ? 'fin-dash__neg' : ''}>
                  {f.name}
                </a>
              ) : (
                <span>{f.name}</span>
              )}
              <span className="fin-dash__muted">
                {FILE_STATUS[f.status] ?? f.status}
                {f.error ? ` — ${f.error}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function SheetView({ sheet, data, onClose, onDone }: { sheet: NonNullable<Sheet>; data: SocialSecurityResponse; onClose: () => void; onDone: () => void }) {
  const latest = data.latest!;
  const fra = latest.fra_years ?? 67;
  if (sheet.kind === 'import') return <ImportSheet onClose={onClose} onDone={onDone} />;
  if (sheet.kind === 'age') {
    const age = sheet.age === 'early' ? 62 : sheet.age === 'late' ? 70 : fra;
    const key = sheet.age === 'early' ? 'at62' : sheet.age === 'late' ? 'at70' : 'atFra';
    const pts = data.estimates.filter((e) => e[key] != null);
    return (
      <DetailSheet title={`Starting at ${age}`} sub={`${money(latest.retirement[String(age)])}/mo on the ${fullDate(latest.statement_date)} statement`} onClose={onClose}>
        <FinanceLineChart
          ariaLabel={`Estimate at ${age} by statement`}
          formatX={fmtYear}
          formatY={(v) => compact(v)}
          series={[{ name: `At ${age}`, color: age < fra ? C_EARLY : age === fra ? C_FRA : C_LATE, points: pts.filter((e) => !e.sameAsPrevious).map((e) => ({ x: dateX(e.statement), y: e[key]! })) }]}
        />
        <table className="fin-dash__table">
          <thead>
            <tr>
              <th>Statement</th>
              <th className="rewards__num">At {age}</th>
              <th className="rewards__num">Assumed Earnings</th>
            </tr>
          </thead>
          <tbody>
            {[...pts].reverse().map((e) => (
              <tr key={e.statement}>
                <td>{fullDate(e.statement)}</td>
                <td className="rewards__num">{money(e[key])}</td>
                <td className="rewards__num">{money(e.assumed)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {age === 62 && data.statements.some((s) => s.age62_stop_now) && <p className="fin-dash__note">The 2009–2010 statements’ age-62 figure assumed you stopped working right then.</p>}
      </DetailSheet>
    );
  }
  if (sheet.kind === 'worth') {
    const tf = latest.trust_fund;
    return (
      <DetailSheet title="Social Security in Savings Terms" sub="What it would take, invested, to pay yourself the same" onClose={onClose}>
        <p className="fin-dash__muted">
          A rule of thumb for net-worth planning: an inflation-adjusted income of $1 a year is worth about $25 saved (the 4% rule). Social Security isn’t an asset you can spend or leave to anyone, so it isn’t
          in your net worth — but it shrinks the nest egg you need.
        </p>
        <table className="fin-dash__table">
          <thead>
            <tr>
              <th>Start</th>
              <th className="rewards__num">Monthly</th>
              <th className="rewards__num">In Savings</th>
              {tf && <th className="rewards__num">At {tf.pct}%</th>}
            </tr>
          </thead>
          <tbody>
            {Object.entries(latest.retirement).map(([age, m]) => (
              <tr key={age}>
                <td>{age}</td>
                <td className="rewards__num">{money(m)}</td>
                <td className="rewards__num">{compact((m * 12) / WITHDRAWAL)}</td>
                {tf && <td className="rewards__num">{compact((((m * tf.pct) / 100) * 12) / WITHDRAWAL)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
        {tf && <p className="fin-dash__note">SSA’s outlook: after {tf.year}, about {tf.pct}% of scheduled benefits would be payable unless Congress acts.</p>}
      </DetailSheet>
    );
  }
  if (sheet.kind === 'taxes') {
    const pts = data.statements.filter((s) => s.taxes.ss_you != null && !s.sameAsPrevious);
    return (
      <DetailSheet title="Social Security & Medicare Taxes" sub="Paid over your career, as each statement estimated it" onClose={onClose}>
        <FinanceLineChart
          ariaLabel="Career taxes paid by statement"
          formatX={fmtYear}
          formatY={(v) => compact(v)}
          series={[
            { name: 'You', color: C_FRA, points: pts.map((s) => ({ x: dateX(s.statement_date), y: (s.taxes.ss_you ?? 0) + (s.taxes.medicare_you ?? 0) })) },
            { name: 'Employers', color: C_EARLY, points: pts.map((s) => ({ x: dateX(s.statement_date), y: (s.taxes.ss_employer ?? 0) + (s.taxes.medicare_employer ?? 0) })) },
          ]}
        />
        <table className="fin-dash__table">
          <tbody>
            <tr>
              <td>Social Security — you</td>
              <td className="rewards__num">{money(latest.taxes.ss_you)}</td>
            </tr>
            <tr>
              <td>Social Security — employers</td>
              <td className="rewards__num">{money(latest.taxes.ss_employer)}</td>
            </tr>
            <tr>
              <td>Medicare — you</td>
              <td className="rewards__num">{money(latest.taxes.medicare_you)}</td>
            </tr>
            <tr>
              <td>Medicare — employers</td>
              <td className="rewards__num">{money(latest.taxes.medicare_employer)}</td>
            </tr>
          </tbody>
        </table>
        <p className="fin-dash__note">Employers paid more Social Security tax than you because of the 2011–2012 payroll-tax holiday (you paid 4.2% instead of 6.2%).</p>
      </DetailSheet>
    );
  }
  if (sheet.kind === 'year') {
    const y = data.years.find((x) => x.year === sheet.year);
    if (!y) return null;
    return (
      <DetailSheet title={String(y.year)} sub={`${money(y.ss)} taxed for Social Security · max ${money(y.wageBase)}`} onClose={onClose}>
        <table className="fin-dash__table">
          <tbody>
            <tr>
              <td>Taxed for Medicare</td>
              <td className="rewards__num">{money(y.medicare)}</td>
            </tr>
            <tr>
              <td>In today’s dollars (wage-indexed)</td>
              <td className="rewards__num">{money(y.indexed)}</td>
            </tr>
            <tr>
              <td>In your best 35 years</td>
              <td className="rewards__num">{y.counted ? 'Yes' : 'No'}</td>
            </tr>
            {y.w2 != null && (
              <tr>
                <td>W-2 wages on your return</td>
                <td className="rewards__num">{money(y.w2)}</td>
              </tr>
            )}
          </tbody>
        </table>
        {y.history.length > 0 && (
          <>
            <h4 className="fin-dash__subtitle">On Each Statement</h4>
            <table className="fin-dash__table">
              <thead>
                <tr>
                  <th>Statement</th>
                  <th className="rewards__num">Social Security</th>
                  <th className="rewards__num">Medicare</th>
                </tr>
              </thead>
              <tbody>
                {y.history.map((h) => (
                  <tr key={h.statement}>
                    <td>
                      {fullDate(h.statement)}
                      {h.latestOnThatStatement ? <span className="fin-dash__muted"> · newest year</span> : null}
                    </td>
                    <td className="rewards__num">{money(h.ss)}</td>
                    <td className="rewards__num">{money(h.medicare)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {y.estimated && <p className="fin-dash__note">Only seen as part of a combined range — spread evenly.</p>}
      </DetailSheet>
    );
  }
  const s = data.statements.find((x) => x.id === sheet.id);
  if (!s) return null;
  const file = data.drive.files.find((f) => f.fileId === s.file_id);
  return (
    <DetailSheet title={`Statement · ${fullDate(s.statement_date)}`} sub={LAYOUT[s.layout] ?? s.layout} onClose={onClose}>
      <table className="fin-dash__table">
        <tbody>
          {Object.entries(s.retirement).map(([age, m]) => (
            <tr key={age}>
              <td>Retirement at {age}</td>
              <td className="rewards__num">{money(m)}/mo</td>
            </tr>
          ))}
          <tr>
            <td>Assumed yearly earnings</td>
            <td className="rewards__num">{money(s.assumed_earnings)}</td>
          </tr>
          <tr>
            <td>Disability</td>
            <td className="rewards__num">{money(s.disability)}/mo</td>
          </tr>
          <tr>
            <td>Survivors: minor child</td>
            <td className="rewards__num">{money(s.survivors.child)}/mo</td>
          </tr>
          <tr>
            <td>Family maximum</td>
            <td className="rewards__num">{money(s.survivors.family_max)}/mo</td>
          </tr>
          <tr>
            <td>Taxes paid (you + employers)</td>
            <td className="rewards__num">{money((s.taxes.ss_you ?? 0) + (s.taxes.medicare_you ?? 0) + (s.taxes.ss_employer ?? 0) + (s.taxes.medicare_employer ?? 0))}</td>
          </tr>
          {s.trust_fund && (
            <tr>
              <td>Trust fund outlook</td>
              <td className="rewards__num">
                {s.trust_fund.pct}% from {s.trust_fund.year}
              </td>
            </tr>
          )}
          <tr>
            <td>Earnings years shown</td>
            <td className="rewards__num">
              {s.earnings[0]?.from}–{s.earnings[s.earnings.length - 1]?.to}
            </td>
          </tr>
        </tbody>
      </table>
      {s.notes && <p className="fin-dash__note">{s.notes}</p>}
      {file?.webUrl && (
        <a className="btn btn--ghost btn--sm" href={file.webUrl} target="_blank" rel="noopener noreferrer">
          Open PDF ↗
        </a>
      )}
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
      await api.importSocialSecurity(text);
      onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <DetailSheet title="Import Statement" sub="Paste or choose the JSON — a statement with the same date is replaced" onClose={onClose}>
      <input type="file" accept=".json,application/json" onChange={(e) => e.target.files?.[0]?.text().then(setText)} />
      <textarea className="input credit-import__text" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder='{ "statements": [ … ] }' />
      {err && <p className="fin-dash__neg">{err}</p>}
      <button type="button" className="btn" disabled={busy || !text.trim()} onClick={run}>
        {busy ? 'Importing…' : 'Import'}
      </button>
    </DetailSheet>
  );
}

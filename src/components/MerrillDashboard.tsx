import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { MerrillDashboard as Data, MlAccountSummary, MlAllocation, MlHolding, MlInsight, MlMergedHolding, MlReturns, MlSeriesPoint } from '../api/types';
import { FinanceLineChart } from './FinanceLineChart';
import { DashTitle } from './dash/InfoTip';
import { DetailSheet } from './dash/DetailSheet';
import { SectionPicker } from './dash/SectionPicker';
import { copyText } from '../utils/clipboard';

/** Finance → Merrill Lynch (Mike, 2026-10-21): the monthly Merrill packages
 * (rollover IRA, Roth IRA, taxable CMA) + Chase's UTMA, read by the worker
 * (templates/merrill.ts → merrillSummary.ts). Is it beating the market after
 * fees, what the fee costs, are we aggressive/conservative in the right
 * places, taxes (gains, harvesting, wash sales), a retirement what-if, where
 * Chase's money should go, and questions for the advisor. */

type Tab = 'overview' | 'performance' | 'fees' | 'allocation' | 'taxes' | 'plan' | 'chase' | 'questions' | 'statements';
const TABS: [Tab, string][] = [
  ['overview', 'Overview'],
  ['performance', 'Performance'],
  ['fees', 'Fees'],
  ['allocation', 'Allocation'],
  ['taxes', 'Taxes'],
  ['plan', 'Retirement'],
  ['chase', 'Chase'],
  ['questions', 'Questions'],
  ['statements', 'Statements'],
];

type Sheet = { kind: 'account'; number: string } | { kind: 'holding'; key: string } | { kind: 'insight'; key: string } | { kind: 'statement'; id: string } | null;

const C_NET = '#2A6FB0';
const C_BLEND = '#C0662E';
const C_SPY = '#7A5BB5';
const C_US = '#2A6FB0';
const C_INTL = '#5B9BD5';
const C_FIXED = '#C0662E';
const C_CASH = '#8A8F98';
const C_OTHER = '#7A5BB5';
const PLAN_KEY = 'mikeos.merrill.plan';

const money = (n: number | null | undefined) => (n == null ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`);
const money2 = (n: number | null | undefined) => (n == null ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const compact = (n: number) => (Math.abs(n) >= 1e6 ? `${n < 0 ? '−' : ''}$${(Math.abs(n) / 1e6).toFixed(2)}M` : Math.abs(n) >= 1e4 ? `${n < 0 ? '−' : ''}$${Math.round(Math.abs(n) / 1000)}K` : money(n));
const pct = (x: number | null | undefined, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const signedPct = (x: number | null | undefined, d = 1) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`);
const fullDate = (iso: string | null | undefined) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—');
const monthLabel = (ym: string | null | undefined) => (ym ? new Date(`${ym.slice(0, 7)}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const dateX = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10) || '15'));
const fmtYear = (ms: number) => String(new Date(ms).getUTCFullYear());
const tone = (x: number | null | undefined) => (x == null ? undefined : x >= 0 ? 'bee-delta--up' : 'bee-delta--down');

export function MerrillDashboard({ data, onDismissFlag, onReload }: { data: Data; onDismissFlag: (id: string) => void; onReload: () => void }) {
  const [params, setParams] = useSearchParams();
  const [sheet, setSheet] = useState<Sheet>(null);
  const s = data.summary;
  const tab = (TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'overview') as Tab;
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t === 'overview') next.delete('tab');
    else next.set('tab', t);
    setParams(next, { replace: true });
  };
  const tabs = TABS.filter(([k]) => k !== 'chase' || s.chase || data.ny529);

  return (
    <div className="fin-dash ml-dash">
      {data.flags.length > 0 && (
        <div className="fin-dash__flags">
          {data.flags.map((f) => (
            <div key={f.id} className={`fin-dash__flag fin-dash__flag--${f.severity}`}>
              <span className="fin-dash__flag-icon">{f.severity === 'warn' ? '⚠' : 'ℹ'}</span>
              <span className="fin-dash__flag-msg">{f.message}</span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => onDismissFlag(f.id)}>
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}

      <SectionPicker options={tabs} value={tab} onChange={setTab} label="Section" className="ml-dash__tabs" />

      {tab === 'overview' && <Overview data={data} onSheet={setSheet} onTab={setTab} />}
      {tab === 'performance' && <Performance data={data} />}
      {tab === 'fees' && <Fees data={data} />}
      {tab === 'allocation' && <AllocationView data={data} onSheet={setSheet} />}
      {tab === 'taxes' && <Taxes data={data} />}
      {tab === 'plan' && <Plan data={data} onReload={onReload} />}
      {tab === 'chase' && <Chase data={data} />}
      {tab === 'questions' && <Questions data={data} />}
      {tab === 'statements' && <Statements data={data} onSheet={setSheet} />}

      {sheet && <SheetView sheet={sheet} data={data} onClose={() => setSheet(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- shared bits

function Tile({ label, value, sub, onClick }: { label: string; value: React.ReactNode; sub?: React.ReactNode; onClick?: () => void }) {
  const body = (
    <>
      <span className="fin-dash__stat-label">{label}</span>
      <span className="fin-dash__stat-value">{value}</span>
      {sub !== undefined && <span className="fin-dash__stat-sub">{sub}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className="fin-dash__stat" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="fin-dash__stat">{body}</div>
  );
}

function InsightRow({ i, onOpen }: { i: MlInsight; onOpen?: () => void }) {
  return (
    <li className={`taxes-insight taxes-insight--${i.severity}`}>
      <span className="taxes-insight__icon">{i.severity === 'good' ? '✓' : i.severity === 'warn' ? '⚠' : 'ⓘ'}</span>
      <span className="taxes-insight__body">
        {onOpen ? (
          <button type="button" className="ml-dash__link" onClick={onOpen}>
            <strong>{i.title}</strong>
          </button>
        ) : (
          <strong>{i.title}</strong>
        )}
        <span className="fin-dash__muted">{i.detail}</span>
      </span>
    </li>
  );
}

function MixBar({ a, height = 10 }: { a: MlAllocation; height?: number }) {
  const parts: [string, number, string][] = [
    ['US stocks', a.us, C_US],
    ['International stocks', a.intl, C_INTL],
    ['Bonds', a.fixed, C_FIXED],
    ['Cash', a.cash, C_CASH],
    ['Other', a.other, C_OTHER],
  ];
  return (
    <div className="ml-mix" style={{ height }} role="img" aria-label={parts.filter((p) => p[1] > 0.005).map(([l, v]) => `${l} ${Math.round(v * 100)}%`).join(', ')}>
      {parts
        .filter((p) => p[1] > 0.002)
        .map(([l, v, c]) => (
          <span key={l} title={`${l} ${Math.round(v * 100)}%`} style={{ width: `${v * 100}%`, background: c }} />
        ))}
    </div>
  );
}

function MixLegend({ a }: { a: MlAllocation }) {
  const parts: [string, number, string][] = [
    ['US Stocks', a.us, C_US],
    ['Intl Stocks', a.intl, C_INTL],
    ['Bonds', a.fixed, C_FIXED],
    ['Cash', a.cash, C_CASH],
    ['Other', a.other, C_OTHER],
  ];
  return (
    <ul className="ml-legend">
      {parts
        .filter((p) => p[1] > 0.005)
        .map(([l, v, c]) => (
          <li key={l}>
            <span className="ml-legend__dot" style={{ background: c }} />
            {l} <strong>{Math.round(v * 100)}%</strong>
          </li>
        ))}
    </ul>
  );
}

function allAccounts(s: Data['summary']): MlAccountSummary[] {
  return [...s.accounts, ...(s.chase ? [s.chase] : [])];
}

// ---------------------------------------------------------------- overview

function Overview({ data, onSheet, onTab }: { data: Data; onSheet: (s: Sheet) => void; onTab: (t: Tab) => void }) {
  const s = data.summary;
  const hh = s.household;
  const [more, setMore] = useState(false);
  if (!hh) return <div className="empty-state">No household statements read yet.</div>;
  const r = hh.returns;
  const ordered = [...s.insights].sort((a, b) => sevRank(a) - sevRank(b));
  const shown = more ? ordered : ordered.slice(0, 6);
  const start = hh.series[0];
  let cum = start ? start.value - start.netFlow - start.market - start.income + start.fees : 0;
  const deposits = hh.series.map((p) => {
    cum += p.netFlow;
    return { x: dateX(p.date), y: Math.max(0, cum) };
  });
  return (
    <>
      <div className="fin-dash__stats fin-dash__stats--5">
        <Tile label="Household Value" value={compact(hh.value)} sub={`as of ${fullDate(hh.asOf)}${s.chase ? ` · + Chase ${compact(s.chase.value)}` : ''}`} onClick={() => onSheet({ kind: 'account', number: 'household' })} />
        <Tile
          label="1-Year Return"
          value={<span className={tone(r.net.y1)}>{pct(r.net.y1)}</span>}
          sub={r.blend.y1 !== null ? `index mix ${pct(r.blend.y1)} · S&P ${pct(r.spy.y1)}` : 'after fees'}
          onClick={() => onTab('performance')}
        />
        <Tile label="3-Year / yr" value={<span className={tone(r.net.y3)}>{pct(r.net.y3)}</span>} sub={r.net.y3 !== null && r.blend.y3 !== null ? <span className={tone(r.net.y3 - r.blend.y3)}>{signedPct(r.net.y3 - r.blend.y3)} vs index mix</span> : 'after fees'} onClick={() => onTab('performance')} />
        <Tile label="Fees · 12 Mo" value={money(hh.fees.trailing12)} sub={hh.fees.rate12 !== null ? `${hh.fees.rate12.toFixed(2)}% a year` : ''} onClick={() => onTab('fees')} />
        <Tile label="Unrealized Gain" value={compact(hh.unrealized ?? 0)} sub={hh.estIncome ? `${money(hh.estIncome)}/yr est. income` : ''} onClick={() => onTab('taxes')} />
      </div>

      <div className="fin-dash__grid">
        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle
            info={
              <>
                <p>Rule-based checks on your statements: performance after fees vs an index-fund mix with the same stock/bond/cash split, fees vs low-cost options, allocation, asset location, taxes and Chase’s account.</p>
                <p>Questions marked here collect on the Questions tab for your next advisor meeting. Not financial advice.</p>
              </>
            }
          >
            Things to Check
          </DashTitle>
          <ul className="taxes-insights">
            {shown.map((i) => (
              <InsightRow key={i.key} i={i} onOpen={() => onSheet({ kind: 'insight', key: i.key })} />
            ))}
          </ul>
          {ordered.length > 6 && (
            <button type="button" className="btn btn--ghost btn--sm taxes-insights__more" onClick={() => setMore((v) => !v)}>
              {more ? 'Show Fewer' : `Show ${ordered.length - 6} More`}
            </button>
          )}
        </section>

        <section className="fin-dash__card fin-dash__card--wide">
          <DashTitle info={<p>Month-end value of the IRA, Roth and CMA together, and the money you put in (rollovers, deposits, transferred shares) minus anything taken out. The gap between the lines is what the investments earned after fees.</p>}>
            Value Over Time
          </DashTitle>
          <FinanceLineChart
            ariaLabel="Household value and money put in"
            formatX={fmtYear}
            formatY={(v) => compact(v)}
            series={[
              { name: 'Value', color: C_NET, points: hh.series.map((p) => ({ x: dateX(p.date), y: p.value })) },
              { name: 'Money Put In', color: C_CASH, step: true, points: deposits },
            ]}
          />
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>Each account’s value, stock/bond/cash mix and fee. Tap one for its holdings and returns.</p>}>Accounts</DashTitle>
          <ul className="ml-accts">
            {allAccounts(s).map((a) => (
              <li key={a.number}>
                <button type="button" className="ml-acct" onClick={() => onSheet({ kind: 'account', number: a.number })}>
                  <span className="ml-acct__top">
                    <strong>{a.label}</strong>
                    <span className="fin-dash__muted">••{a.last4}</span>
                    <span className="ml-acct__value">{money(a.value)}</span>
                  </span>
                  <MixBar a={a.allocation} />
                  <span className="fin-dash__muted ml-acct__sub">
                    {a.strategy ?? '—'} · 1Y {pct(a.returns.net.y1)}
                    {a.fees.rate12 !== null ? ` · fee ${a.fees.rate12.toFixed(2)}%` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}

const sevRank = (i: MlInsight) => (i.severity === 'warn' ? 0 : i.severity === 'info' ? 1 : 2);

// ---------------------------------------------------------------- performance

function useAccountPick(s: Data['summary']) {
  const opts = useMemo(() => {
    const o: [string, string][] = [];
    if (s.household) o.push(['household', 'All Household']);
    for (const a of allAccounts(s)) o.push([a.number, `${a.label} ••${a.last4}`]);
    return o;
  }, [s]);
  const [pick, setPick] = useState<string>(opts[0]?.[0] ?? 'household');
  const acct = pick === 'household' ? s.household : allAccounts(s).find((a) => a.number === pick) ?? null;
  return { opts, pick, setPick, acct };
}

function AccountSelect({ opts, pick, setPick }: { opts: [string, string][]; pick: string; setPick: (v: string) => void }) {
  return (
    <select className="ml-select" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Account">
      {opts.map(([k, l]) => (
        <option key={k} value={k}>
          {l}
        </option>
      ))}
    </select>
  );
}

function growth(series: MlSeriesPoint[], pick: (p: MlSeriesPoint) => number | null) {
  const out: { x: number; y: number }[] = [];
  let v = 10000;
  let started = false;
  for (const p of series) {
    const r = pick(p);
    if (p.rNet === null) continue;
    if (r === null) {
      if (started) return out; // benchmark ends — stop the line there
      continue;
    }
    if (!started) {
      out.push({ x: dateX(p.date) - 30 * 86400000, y: v });
      started = true;
    }
    v *= 1 + r;
    out.push({ x: dateX(p.date), y: v });
  }
  return out;
}

function calendarYears(series: MlSeriesPoint[]) {
  const years = new Map<number, { net: number; gross: number; blend: number | null; spy: number | null; months: number }>();
  for (const p of series) {
    if (p.rNet === null) continue;
    const y = Number(p.date.slice(0, 4));
    const e = years.get(y) ?? { net: 1, gross: 1, blend: 1, spy: 1, months: 0 };
    e.net *= 1 + p.rNet;
    e.gross *= 1 + (p.rGross ?? p.rNet);
    e.blend = e.blend === null || p.rBlend === null ? null : e.blend * (1 + p.rBlend);
    e.spy = e.spy === null || p.rSpy === null ? null : e.spy * (1 + p.rSpy);
    e.months++;
    years.set(y, e);
  }
  return [...years]
    .map(([year, e]) => ({ year, net: e.net - 1, gross: e.gross - 1, blend: e.blend === null ? null : e.blend - 1, spy: e.spy === null ? null : e.spy - 1, months: e.months }))
    .sort((a, b) => b.year - a.year);
}

function Performance({ data }: { data: Data }) {
  const s = data.summary;
  const { opts, pick, setPick, acct } = useAccountPick(s);
  if (!acct) return <div className="empty-state">Nothing to show yet.</div>;
  const r = acct.returns;
  const rows: [string, MlReturns, string?][] = [
    ['After Fees', r.net, 'ml-ret--you'],
    ['Before Fees', r.gross],
    ['Same Mix, Index Funds', r.blend],
    ['S&P 500', r.spy],
  ];
  const diff = (k: keyof Omit<MlReturns, 'sinceMonths' | 'sinceStart'>) => (r.net[k] !== null && r.blend[k] !== null ? (r.net[k] as number) - (r.blend[k] as number) : null);
  const years = calendarYears(acct.series);
  const noBench = !data.market.months;
  return (
    <>
      <div className="dash-controls dash-controls--solo">
        <AccountSelect opts={opts} pick={pick} setPick={setPick} />
        <span className="dash-controls__range-text">
          Since {monthLabel(r.net.sinceStart)} · {r.net.sinceMonths} months
        </span>
      </div>
      {noBench && <p className="fin-dash__note">Benchmark prices haven’t loaded yet — they’re pulled nightly with the statement scan.</p>}
      <div className="fin-dash__stats">
        <Tile label="vs Index Mix · 1 Yr" value={<span className={tone(acct.valueAdded.vsBlend.y1)}>{money(acct.valueAdded.vsBlend.y1)}</span>} sub={<span className={tone(diff('y1'))}>{signedPct(diff('y1'))}</span>} />
        <Tile label="vs Index Mix · 3 Yrs" value={<span className={tone(acct.valueAdded.vsBlend.y3)}>{money(acct.valueAdded.vsBlend.y3)}</span>} sub={<span className={tone(diff('y3'))}>{signedPct(diff('y3'))} a year</span>} />
        <Tile label="vs Index Mix · All" value={<span className={tone(acct.valueAdded.vsBlend.since)}>{money(acct.valueAdded.vsBlend.since)}</span>} sub={<span className={tone(diff('since'))}>{signedPct(diff('since'))} a year</span>} />
        <Tile label="vs S&P 500 · All" value={<span className={tone(acct.valueAdded.vsSpy.since)}>{money(acct.valueAdded.vsSpy.since)}</span>} sub="same deposits, all in SPY" />
      </div>
      <div className="fin-dash__grid">
        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle
            info={
              <>
                <p>
                  <strong>Time-weighted</strong> returns from each month’s statement (deposits and transfers don’t count as gains). 3 and 5 years and “Start” are per year. <strong>After Fees</strong> is what you actually earned; <strong>Before Fees</strong> adds the advisory fee back.
                </p>
                <p>
                  <strong>Same Mix, Index Funds</strong> is the fair test: each month, cheap index ETFs in this account’s own stock/bond/cash split at the start of the month (US stocks VTI, international VXUS, bonds AGG, cash BIL), dividends reinvested. The S&amp;P 500 is shown for reference — it’s all US
                  stocks, so it isn’t a fair yardstick for an account holding bonds or international.
                </p>
                <p>Dollar figures: what the same deposits would be worth today in that benchmark, minus what you have.</p>
              </>
            }
          >
            Returns
          </DashTitle>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table ml-ret">
              <thead>
                <tr>
                  <th />
                  <th className="num">YTD</th>
                  <th className="num">1Y</th>
                  <th className="num">3Y</th>
                  <th className="num">5Y</th>
                  <th className="num">Start</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([label, x, cls]) => (
                  <tr key={label} className={cls}>
                    <td>{label}</td>
                    <td className="num">{pct(x.ytd)}</td>
                    <td className="num">{pct(x.y1)}</td>
                    <td className="num">{pct(x.y3)}</td>
                    <td className="num">{pct(x.y5)}</td>
                    <td className="num">{pct(x.since)}</td>
                  </tr>
                ))}
                <tr className="ml-ret--diff">
                  <td>Difference vs Mix</td>
                  {(['ytd', 'y1', 'y3', 'y5', 'since'] as const).map((k) => (
                    <td key={k} className={`num ${tone(diff(k)) ?? ''}`}>
                      {signedPct(diff(k))}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="fin-dash__card fin-dash__card--wide">
          <DashTitle info={<p>What $10,000 would have grown to since the start, after fees, vs the same-mix index funds and the S&amp;P 500. Deposits don’t move these lines.</p>}>Growth of $10,000</DashTitle>
          <FinanceLineChart
            ariaLabel="Growth of 10,000 dollars"
            formatX={fmtYear}
            formatY={(v) => compact(v)}
            yFromZero={false}
            series={[
              { name: 'You (after fees)', color: C_NET, points: growth(acct.series, (p) => p.rNet) },
              { name: 'Same mix, index funds', color: C_BLEND, points: growth(acct.series, (p) => p.rBlend) },
              { name: 'S&P 500', color: C_SPY, points: growth(acct.series, (p) => p.rSpy) },
            ]}
          />
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>Calendar-year returns, after fees, vs the same-mix index funds. Partial first years are marked.</p>}>By Year</DashTitle>
          <ul className="credit-mini ml-years">
            {years.map((y) => (
              <li key={y.year}>
                <span>
                  {y.year}
                  {y.months < 12 ? <span className="fin-dash__muted"> ({y.months} mo)</span> : null}
                </span>
                <span>
                  <strong className={tone(y.net)}>{pct(y.net)}</strong>
                  <span className="fin-dash__muted"> · mix {pct(y.blend)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- fees

function Fees({ data }: { data: Data }) {
  const s = data.summary;
  const hh = s.household;
  const [ret, setRet] = useState(6.5);
  if (!hh) return null;
  const rate = hh.fees.rate12 ?? 1;
  const bal = hh.value;
  const fv = (fee: number, years: number) => bal * Math.pow(1 + ret / 100 - fee / 100, years);
  const scenarios: [string, number][] = [
    [`Merrill now (${rate.toFixed(2)}%)`, rate],
    ['Robo-advisor (0.25%)', 0.25],
    ['Index funds alone (0.05%)', 0.05],
  ];
  const monthly = hh.series.slice(-36);
  return (
    <>
      <div className="fin-dash__stats">
        <Tile label="Last 12 Months" value={money(hh.fees.trailing12)} sub={hh.fees.rate12 !== null ? `${hh.fees.rate12.toFixed(2)}% of the balance` : ''} />
        <Tile label="This Year" value={money(hh.fees.ytd)} sub={`through ${fullDate(hh.asOf)}`} />
        <Tile label="Since 2018" value={money(hh.fees.allTime)} sub="advisory fees paid" />
        <Tile label="Fee Drag" value={hh.returns.gross.y3 !== null && hh.returns.net.y3 !== null ? pct(hh.returns.gross.y3 - hh.returns.net.y3, 2) : pct(hh.returns.gross.since !== null && hh.returns.net.since !== null ? hh.returns.gross.since - hh.returns.net.since : null, 2)} sub="returns lost to fees, per year" />
      </div>
      <div className="fin-dash__grid">
        <section className="fin-dash__card fin-dash__card--wide">
          <DashTitle
            info={
              <>
                <p>
                  The advisory (“Program”) fee Merrill deducts monthly from each account. The rate is fees over the last 12 months ÷ the average balance. Not included: what the ETFs and funds inside charge (their expense ratios — usually 0.03–0.5%), and the JP Morgan SMA’s manager rate listed on the CMA and IRA
                  strategy.
                </p>
                <p>Reference points are typical market rates, not quotes: robo-advisors ~0.25%, a self-managed index portfolio ~0.05% in fund costs.</p>
              </>
            }
          >
            What the Fee Costs Over Time
          </DashTitle>
          <div className="ml-calc">
            <label>
              Assumed return
              <select className="ml-select" value={ret} onChange={(e) => setRet(Number(e.target.value))}>
                {[5, 6, 6.5, 7, 8].map((x) => (
                  <option key={x} value={x}>
                    {x}% a year
                  </option>
                ))}
              </select>
            </label>
            <span className="fin-dash__muted">on today’s {compact(bal)}, no new deposits</span>
          </div>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table">
              <thead>
                <tr>
                  <th />
                  <th className="num">10 Yrs</th>
                  <th className="num">20 Yrs</th>
                  <th className="num">Fee / Yr Now</th>
                </tr>
              </thead>
              <tbody>
                {scenarios.map(([label, fee]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td className="num">{compact(fv(fee, 10))}</td>
                    <td className="num">{compact(fv(fee, 20))}</td>
                    <td className="num">{money((bal * fee) / 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="fin-dash__note">
            At {ret}% a year, the difference between {rate.toFixed(2)}% and 0.25% is about <strong>{compact(fv(0.25, 20) - fv(rate, 20))}</strong> after 20 years. That’s the bar the advice has to clear — in returns, taxes saved, or planning you’d otherwise pay for.
          </p>
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>Fees by year and the effective rate (that year’s fees, annualized, ÷ its average balance).</p>}>By Year</DashTitle>
          <ul className="credit-mini">
            {[...hh.fees.byYear].reverse().map((y) => (
              <li key={y.year}>
                <span>
                  {y.year}
                  {y.months < 12 ? <span className="fin-dash__muted"> ({y.months} mo)</span> : null}
                </span>
                <span>
                  <strong>{money(y.fees)}</strong>
                  <span className="fin-dash__muted"> · {y.rate !== null ? `${y.rate.toFixed(2)}%` : '—'}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="fin-dash__card fin-dash__card--wide">
          <DashTitle info={<p>The advisory fee each month (last 3 years), all household accounts. It grows with the balance.</p>}>Monthly Fee</DashTitle>
          <FinanceLineChart ariaLabel="Monthly advisory fee" formatX={fmtYear} formatY={(v) => money(v)} series={[{ name: 'Fee', color: C_FIXED, points: monthly.map((p) => ({ x: dateX(p.date), y: p.fees })) }]} />
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>Last 12 months, per account.</p>}>By Account</DashTitle>
          <ul className="credit-mini">
            {allAccounts(s).map((a) => (
              <li key={a.number}>
                <span>{a.label}</span>
                <span>
                  <strong>{money(a.fees.trailing12)}</strong>
                  <span className="fin-dash__muted"> · {a.fees.rate12 !== null ? `${a.fees.rate12.toFixed(2)}%` : '—'}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- allocation

function glide(yearsToRetire: number) {
  const pts: [number, number][] = [
    [40, 0.9],
    [25, 0.9],
    [20, 0.85],
    [15, 0.78],
    [10, 0.68],
    [5, 0.57],
    [0, 0.5],
  ];
  const y = Math.max(0, Math.min(40, yearsToRetire));
  for (let i = 0; i < pts.length - 1; i++) {
    const [y1, e1] = pts[i];
    const [y2, e2] = pts[i + 1];
    if (y <= y1 && y >= y2) return e2 + ((e1 - e2) * (y - y2)) / (y1 - y2 || 1);
  }
  return 0.5;
}

function AllocationView({ data, onSheet }: { data: Data; onSheet: (s: Sheet) => void }) {
  const s = data.summary;
  const hh = s.household;
  const [q, setQ] = useState('');
  if (!hh) return null;
  const age = s.retirement.age;
  const ref = age !== null ? glide(data.settings.retireAge - age) : null;
  const list = s.holdings.filter((h) => !q || `${h.name} ${h.symbol ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const allocInsights = s.insights.filter((i) => i.area === 'allocation');
  return (
    <>
      <div className="fin-dash__grid">
        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle
            info={
              <>
                <p>Stocks vs bonds vs cash across the IRA, Roth and CMA, from the holdings on the latest statement (funds are split by Merrill’s own asset-class line, e.g. “Fixed Income 14% Equity 86%”). International = funds and stocks outside the US.</p>
                <p>The reference is roughly what big target-date funds hold for someone retiring in {age !== null ? data.settings.retireAge - age : '—'} years (change the age on the Retirement tab). A guide, not a rule.</p>
              </>
            }
          >
            Household Mix
          </DashTitle>
          <MixBar a={hh.allocation} height={16} />
          <MixLegend a={hh.allocation} />
          {ref !== null && (
            <p className="fin-dash__note">
              {Math.round(hh.allocation.equity * 100)}% stocks today · a target-date fund for retiring at {data.settings.retireAge} would hold about <strong>{Math.round(ref * 100)}%</strong>.
            </p>
          )}
          {allocInsights.length > 0 && (
            <ul className="taxes-insights">
              {allocInsights.map((i) => (
                <InsightRow key={i.key} i={i} />
              ))}
            </ul>
          )}
        </section>

        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle info={<p>Each account’s mix and the strategy Merrill runs it with (sleeves and their style-manager rates as printed). Roth money is never taxed, so it should hold the most growth; bonds are best in the IRA, where their interest isn’t taxed yearly.</p>}>By Account</DashTitle>
          <ul className="ml-accts ml-accts--wide">
            {allAccounts(s).map((a) => (
              <li key={a.number}>
                <button type="button" className="ml-acct" onClick={() => onSheet({ kind: 'account', number: a.number })}>
                  <span className="ml-acct__top">
                    <strong>{a.label}</strong>
                    <span className="fin-dash__muted">{a.strategy ?? '—'}</span>
                    <span className="ml-acct__value">{money(a.value)}</span>
                  </span>
                  <MixBar a={a.allocation} />
                  <MixLegend a={a.allocation} />
                  {a.sleeves.length > 1 && <span className="fin-dash__muted ml-acct__sub">{a.sleeves.map((x) => `${titleCase(x.name)} ${x.pct}%${x.rate ? ` (${x.rate}%)` : ''}`).join(' · ')}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle info={<p>Every holding across the household accounts, merged by symbol. Tap one to see which accounts hold it.</p>}>Holdings</DashTitle>
          <input className="ml-search" type="search" placeholder="Search holdings" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="fin-dash__table-wrap post-table">
            <table className="fin-dash__table">
              <thead>
                <tr>
                  <th>Holding</th>
                  <th className="num">Value</th>
                  <th className="num">Share</th>
                  <th className="num">Gain</th>
                  <th>Accounts</th>
                </tr>
              </thead>
              <tbody>
                {list.slice(0, 200).map((h) => (
                  <tr key={h.key} onClick={() => onSheet({ kind: 'holding', key: h.key })} className="ml-row">
                    <td>
                      {h.symbol && <strong>{h.symbol} </strong>}
                      <span className="fin-dash__muted">{titleCase(h.name)}</span>
                    </td>
                    <td className="num">{money(h.value)}</td>
                    <td className="num">{pct(h.pct)}</td>
                    <td className={`num ${tone(h.gain) ?? ''}`}>{money(h.gain)}</td>
                    <td className="fin-dash__muted">{h.accounts.map((x) => typeShort(x.type)).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="post-cards">
            {list.slice(0, 200).map((h) => (
              <li key={h.key}>
                <button type="button" className="post-card" onClick={() => onSheet({ kind: 'holding', key: h.key })}>
                  <span className="post-card__top">
                    {h.accounts.map((x) => typeShort(x.type)).join(', ')}
                    <span className="ml-card__right">{pct(h.pct)}</span>
                  </span>
                  <span className="post-card__title">
                    {h.symbol && <strong>{h.symbol} </strong>}
                    {titleCase(h.name)}
                  </span>
                  <span className="ml-card__nums">
                    {money(h.value)} · <span className={tone(h.gain)}>{money(h.gain)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}

const typeShort = (t: string) => (t === 'ira' ? 'IRA' : t === 'roth' ? 'Roth' : t === 'cma' ? 'CMA' : 'UTMA');
const titleCase = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Etf|Us|S&p|Msci|Eafe|Cl|Jp|Ii|Iii|Reit|Tips|Mbs|Adr|Cio)\b/g, (m) => m.toUpperCase());

// ---------------------------------------------------------------- taxes

function Taxes({ data }: { data: Data }) {
  const t = data.summary.taxes;
  const [showAllLots, setShowAllLots] = useState(false);
  const lots = showAllLots ? t.harvest.lots : t.harvest.lots.slice(0, 15);
  const year = Number((data.summary.asOf ?? new Date().toISOString()).slice(0, 4));
  return (
    <>
      <div className="fin-dash__stats">
        <Tile label={`Gains Realized ${year}`} value={money((t.ytd?.st ?? 0) + (t.ytd?.lt ?? 0))} sub={`short-term ${money(t.ytd?.st)} · long-term ${money(t.ytd?.lt)}`} />
        <Tile label="Losses Harvested" value={money(-(t.ytd?.harvested ?? 0))} sub={`in ${year}, taxable accounts`} />
        <Tile label="Could Harvest Now" value={money(-t.harvest.total)} sub={`${t.harvest.lots.length} lots down ≥ $100 a position`} />
        <Tile label="Taxable Income" value={money(t.ytd?.income)} sub="dividends & interest this year" />
      </div>
      <div className="fin-dash__grid">
        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle
            info={
              <>
                <p>
                  Only the <strong>taxable</strong> accounts (CMA{data.summary.chase ? ' and Chase’s UTMA' : ''}) create taxes each year. Gains and losses are from each December statement’s year-to-date totals (this year: the latest statement). “Losses harvested” = sales at a loss that year (the lots in the
                  Realized Gains section). “Merrill wash” = sales Merrill itself marked N/C as a wash sale.
                </p>
                <p>The IRA and Roth aren’t taxed on trades — only on withdrawals (IRA) or never (Roth).</p>
              </>
            }
          >
            Taxable Accounts by Year
          </DashTitle>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table">
              <thead>
                <tr>
                  <th>Year</th>
                  <th className="num">Short</th>
                  <th className="num">Long</th>
                  <th className="num">Harvested</th>
                  <th className="num">Income</th>
                </tr>
              </thead>
              <tbody>
                {[...t.years].reverse().map((y) => (
                  <tr key={y.year}>
                    <td>
                      {y.year}
                      {y.partial ? <span className="fin-dash__muted"> YTD</span> : null}
                    </td>
                    <td className="num">{money(y.st)}</td>
                    <td className="num">{money(y.lt)}</td>
                    <td className="num">
                      {money(y.lossesHarvested)}
                      {y.washMarked ? <span className="fin-dash__muted"> · {y.washMarked} wash</span> : null}
                    </td>
                    <td className="num">{money(y.taxableIncome)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle
            info={
              <>
                <p>Open positions in the taxable accounts that are below what you paid — from the lot detail (Equity Cost Basis pages) on the latest statement; funds without lot detail show as one position. Selling books the loss to offset gains (and up to $3,000 of income), and you can buy something similar (not the same security) to stay invested.</p>
                <p>
                  <strong>Wash-sale rule:</strong> if the same security is bought within 30 days before or after the sale in <em>any</em> of your accounts — including the IRA and Roth — the loss is disallowed (and lost for good when the buy is in an IRA). Short = held a year or less.
                </p>
              </>
            }
          >
            Harvest Candidates
          </DashTitle>
          {t.harvest.lots.length === 0 ? (
            <p className="fin-dash__muted">Nothing worth harvesting right now.</p>
          ) : (
            <>
              <div className="fin-dash__table-wrap post-table">
                <table className="fin-dash__table">
                  <thead>
                    <tr>
                      <th>Holding</th>
                      <th>Bought</th>
                      <th className="num">Cost</th>
                      <th className="num">Value</th>
                      <th className="num">Loss</th>
                      <th>Term</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lots.map((l, i) => (
                      <tr key={`${l.account}-${l.symbol}-${l.acquired}-${i}`}>
                        <td>
                          <strong>{l.symbol}</strong> <span className="fin-dash__muted">{typeShort(l.type)}</span>
                        </td>
                        <td>{l.acquired ? fullDate(l.acquired) : '—'}</td>
                        <td className="num">{money2(l.cost)}</td>
                        <td className="num">{money2(l.value)}</td>
                        <td className="num bee-delta--down">{money2(l.loss)}</td>
                        <td>{l.fund ? 'fund' : l.term === 'short' ? 'Short' : 'Long'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="post-cards">
                {lots.map((l, i) => (
                  <li key={`${l.account}-${l.symbol}-${l.acquired}-${i}`}>
                    <div className="post-card">
                      <span className="post-card__top">
                        {typeShort(l.type)} · {l.acquired ? fullDate(l.acquired) : '—'} · {l.fund ? 'fund' : l.term === 'short' ? 'short-term' : 'long-term'}
                      </span>
                      <span className="post-card__title">
                        <strong>{l.symbol}</strong> {titleCase(l.name)}
                      </span>
                      <span className="ml-card__nums">
                        {money2(l.cost)} → {money2(l.value)} · <span className="bee-delta--down">{money2(l.loss)}</span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
              {t.harvest.lots.length > 15 && (
                <button type="button" className="btn btn--ghost btn--sm taxes-insights__more" onClick={() => setShowAllLots((v) => !v)}>
                  {showAllLots ? 'Show Fewer' : `Show All ${t.harvest.lots.length}`}
                </button>
              )}
            </>
          )}
        </section>

        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle
            info={
              <p>
                Sales at a loss in a taxable account where the same security (matched by name) was bought within 30 days in a <em>different</em> account. Merrill’s 1099 only adjusts wash sales inside one account, so these are on you (or your tax preparer) to report — and a buy in the IRA or Roth makes the
                loss permanent. Possible matches: confirm against trade confirmations.
              </p>
            }
          >
            Possible Wash Sales Across Accounts
          </DashTitle>
          {t.washSales.length === 0 ? (
            <p className="fin-dash__muted">None found.</p>
          ) : (
            <ul className="credit-mini ml-wash">
              {t.washSales.slice(0, 40).map((w, i) => (
                <li key={`${w.name}-${w.sold}-${i}`}>
                  <span>
                    <strong>{titleCase(w.name)}</strong>
                    <span className="fin-dash__muted">
                      {' '}
                      sold {fullDate(w.sold)} in {typeShort(w.type)} at {money2(w.loss)} · bought {w.buys.map((b) => `${fullDate(b.date)} in ${typeShort(b.type)}`).join(', ')}
                    </span>
                  </span>
                  <span>{w.permanent ? <span className="bee-delta--down">IRA buy</span> : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- retirement plan

interface PlanState {
  retireAge: number;
  spending: number;
  saving: number;
  ret: number;
  infl: number;
  fee: 'current' | 'index';
  claim: number;
  ss: boolean;
  other: number;
  tax: number;
}

function readPlan(defaults: PlanState): PlanState {
  try {
    const v = JSON.parse(localStorage.getItem(PLAN_KEY) ?? 'null') as Partial<PlanState> | null;
    return { ...defaults, ...(v ?? {}) };
  } catch {
    return defaults;
  }
}

interface ProjYear {
  age: number;
  balance: number;
  real: number;
}

function project(p: PlanState, start: number, age: number, feeRate: number, ssMonthly: number | null, preTaxShare: number, retShift = 0): { path: ProjYear[]; runsOut: number | null; atRetire: number; atRetireReal: number } {
  const r = p.ret / 100 + retShift - (p.fee === 'current' ? feeRate / 100 : 0.001);
  const infl = p.infl / 100;
  let b = start + p.other;
  const path: ProjYear[] = [{ age, balance: b, real: b }];
  let runsOut: number | null = null;
  let atRetire = b;
  for (let a = age + 1, t = 1; a <= 95; a++, t++) {
    const priceIdx = Math.pow(1 + infl, t);
    if (a <= p.retireAge) {
      b = b * (1 + r) + p.saving * priceIdx;
      if (a === p.retireAge) atRetire = b;
    } else {
      const ss = p.ss && ssMonthly && a >= p.claim ? ssMonthly * 12 * priceIdx : 0;
      const need = Math.max(0, p.spending * priceIdx - ss) * (1 + (p.tax / 100) * preTaxShare);
      b = (b - need) * (1 + r);
      if (b <= 0 && runsOut === null) {
        runsOut = a;
        b = 0;
      }
    }
    path.push({ age: a, balance: Math.max(0, b), real: Math.max(0, b) / priceIdx });
  }
  if (p.retireAge <= age) atRetire = start + p.other;
  return { path, runsOut, atRetire, atRetireReal: atRetire / Math.pow(1 + infl, Math.max(0, p.retireAge - age)) };
}

function Plan({ data, onReload }: { data: Data; onReload: () => void }) {
  const s = data.summary;
  const rr = s.retirement;
  const age = rr.age ?? data.ssa?.currentAge ?? null;
  const defaults: PlanState = { retireAge: data.settings.retireAge, spending: 150000, saving: 0, ret: 6.5, infl: 2.5, fee: 'current', claim: 67, ss: true, other: Math.round(data.tsp?.value ?? 0), tax: 18 };
  const [p, setP] = useState<PlanState>(() => readPlan(defaults));
  useEffect(() => {
    try {
      localStorage.setItem(PLAN_KEY, JSON.stringify(p));
    } catch {
      /* per-device convenience only */
    }
  }, [p]);
  // The retirement age also drives the allocation reference (server-side) — save it, debounced.
  useEffect(() => {
    if (p.retireAge === data.settings.retireAge) return;
    const h = setTimeout(() => {
      api.updateStatementFolder(data.folder.id, { settings: { retireAge: p.retireAge } }).then(onReload).catch(() => undefined);
    }, 1200);
    return () => clearTimeout(h);
  }, [p.retireAge, data.settings.retireAge, data.folder.id, onReload]);

  if (age === null) return <div className="empty-state">The projection needs your birth date — it comes from your Social Security statements (Finance → Social Security).</div>;
  const start = rr.preTax + rr.roth + rr.taxable;
  const feeRate = rr.feeRate ?? 1;
  const preTaxShare = start ? rr.preTax / start : 0.5;
  const ssFor = (retire: number, claim: number) => {
    if (!data.ssa) return null;
    const stop = Math.max(data.ssa.stopAges[0], Math.min(retire, data.ssa.stopAges[data.ssa.stopAges.length - 1]));
    const row = data.ssa.grid[String(stop)] ?? data.ssa.grid[String(data.ssa.stopAges.find((x) => x >= stop) ?? data.ssa.stopAges[0])];
    return row?.[String(claim)]?.monthly ?? null;
  };
  const ss = ssFor(p.retireAge, p.claim);
  const base = project(p, start, age, feeRate, ss, preTaxShare);
  const bad = project(p, start, age, feeRate, ss, preTaxShare, -0.02);
  const good = project(p, start, age, feeRate, ss, preTaxShare, 0.015);
  const idx = project({ ...p, fee: 'index' }, start, age, feeRate, ss, preTaxShare);
  const ages = [55, 57, 60, 62, 65].filter((a) => a > age);
  const earliest = (() => {
    for (let a = Math.max(age + 1, 45); a <= 70; a++) {
      const r = project({ ...p, retireAge: a }, start, age, feeRate, ssFor(a, p.claim), preTaxShare);
      if (r.runsOut === null) return a;
    }
    return null;
  })();
  const set = (k: keyof PlanState, v: number | string | boolean) => setP((cur) => ({ ...cur, [k]: v }));
  const lasts = (r: { runsOut: number | null }) => (r.runsOut === null ? 'past 95' : `to age ${r.runsOut - 1}`);
  return (
    <>
      <div className="fin-dash__stats">
        <Tile label={`At ${p.retireAge}`} value={compact(base.atRetireReal)} sub={`in today’s dollars (${compact(base.atRetire)} then)`} />
        <Tile label="Money Lasts" value={lasts(base)} sub={`bad markets: ${lasts(bad)} · good: ${lasts(good)}`} />
        <Tile label="Earliest Safe Age" value={earliest ?? '70+'} sub="money lasts to 95 at your settings" />
        <Tile label="4% Rule Income" value={money(base.atRetireReal * 0.04 + (p.ss && ss && p.claim <= p.retireAge ? ss * 12 : 0))} sub={`a year, today’s $${p.ss && ss ? ` · SS ${money(ss)}/mo at ${p.claim}` : ''}`} />
      </div>

      <div className="fin-dash__grid">
        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle
            info={
              <>
                <p>
                  A simple year-by-year projection of the Merrill IRA, Roth and CMA (plus anything you add under Other Savings), in today’s dollars where noted. Before retiring: growth + your yearly savings (rising with inflation). After: your spending (rising with inflation), less Social Security from
                  your claim age (from your own SSA record, assuming you stop working when you retire), plus a tax allowance on the pre-tax IRA share of withdrawals.
                </p>
                <p>Returns are before fees; the advisory fee ({feeRate.toFixed(2)}%) is subtracted unless you switch to “index funds” (0.10%). “Bad markets” = 2% a year lower; “good” = 1.5% higher. Not financial advice — a way to see how the dials interact.</p>
              </>
            }
          >
            Your Assumptions
          </DashTitle>
          <div className="ml-plan">
            <Dial label="Retire at" value={p.retireAge} min={age + 1} max={70} step={1} fmt={(v) => `${v}`} onChange={(v) => set('retireAge', v)} />
            <Dial label="Spending / yr (today’s $)" value={p.spending} min={40000} max={400000} step={5000} fmt={(v) => money(v)} onChange={(v) => set('spending', v)} />
            <Dial label="Saving / yr until then" value={p.saving} min={0} max={150000} step={2500} fmt={(v) => money(v)} onChange={(v) => set('saving', v)} />
            <Dial label="Return before fees" value={p.ret} min={3} max={10} step={0.5} fmt={(v) => `${v}%`} onChange={(v) => set('ret', v)} />
            <Dial label="Inflation" value={p.infl} min={1} max={5} step={0.25} fmt={(v) => `${v}%`} onChange={(v) => set('infl', v)} />
            <Dial label="Tax on IRA withdrawals" value={p.tax} min={0} max={40} step={1} fmt={(v) => `${v}%`} onChange={(v) => set('tax', v)} />
            <Dial label={data.tsp ? `Other retirement savings (TSP ${money(data.tsp.value)})` : 'Other retirement savings'} value={p.other} min={0} max={2000000} step={10000} fmt={(v) => money(v)} onChange={(v) => set('other', v)} />
            <label className="ml-plan__field">
              <span>Social Security</span>
              <select className="ml-select" value={p.ss ? p.claim : 0} onChange={(e) => (Number(e.target.value) ? setP((cur) => ({ ...cur, ss: true, claim: Number(e.target.value) })) : set('ss', false))}>
                <option value={0}>Leave out</option>
                {[62, 65, 67, 70].map((a) => (
                  <option key={a} value={a}>
                    Start at {a}
                    {ssFor(p.retireAge, a) ? ` — ${money(ssFor(p.retireAge, a))}/mo` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="ml-plan__field">
              <span>Fees</span>
              <select className="ml-select" value={p.fee} onChange={(e) => set('fee', e.target.value)}>
                <option value="current">Merrill ({feeRate.toFixed(2)}%)</option>
                <option value="index">Index funds (0.10%)</option>
              </select>
            </label>
          </div>
          <p className="fin-dash__note">
            Starting from {compact(start)} (IRA {compact(rr.preTax)} · Roth {compact(rr.roth)} · CMA {compact(rr.taxable)}). Your actual return since 2018 has been {pct(rr.historicalNet)}/yr after fees ({pct(rr.historicalBlend)} for the same mix in index funds) — strong years; long-run planning usually assumes
            less.
            {p.fee === 'current' && idx.atRetireReal > base.atRetireReal ? ` Same plan at index-fund costs: ${compact(idx.atRetireReal)} at ${p.retireAge} (+${compact(idx.atRetireReal - base.atRetireReal)}), lasting ${lasts(idx)}.` : ''}
          </p>
        </section>

        <section className="fin-dash__card fin-dash__card--wide">
          <DashTitle info={<p>Balance by age in today’s dollars, for your return assumption and for bad (−2%/yr) and good (+1.5%/yr) markets.</p>}>Balance by Age</DashTitle>
          <FinanceLineChart
            ariaLabel="Projected balance by age"
            formatX={(v) => `${Math.round(v)}`}
            formatY={(v) => compact(v)}
            series={[
              { name: 'Good markets', color: C_SPY, points: good.path.map((y) => ({ x: y.age, y: y.real })) },
              { name: 'Your assumption', color: C_NET, points: base.path.map((y) => ({ x: y.age, y: y.real })) },
              { name: 'Bad markets', color: C_BLEND, points: bad.path.map((y) => ({ x: y.age, y: y.real })) },
            ]}
          />
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>Same assumptions, different retirement ages. Balance in today’s dollars; “lasts” at your spending.</p>}>If You Retire At…</DashTitle>
          <ul className="credit-mini">
            {ages.map((a) => {
              const r = project({ ...p, retireAge: a }, start, age, feeRate, ssFor(a, p.claim), preTaxShare);
              return (
                <li key={a}>
                  <span>{a}</span>
                  <span>
                    <strong>{compact(r.atRetireReal)}</strong>
                    <span className={r.runsOut === null ? 'bee-delta--up' : 'bee-delta--down'}> · lasts {lasts(r)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </>
  );
}

function Dial({ label, value, min, max, step, fmt, onChange }: { label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <label className="ml-plan__field">
      <span>
        {label} <strong>{fmt(value)}</strong>
      </span>
      <input type="range" min={min} max={max} step={step} value={Math.min(max, Math.max(min, value))} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

// ---------------------------------------------------------------- chase

function Chase({ data }: { data: Data }) {
  const c = data.summary.chase;
  const n = data.ny529;
  return (
    <>
      <div className="fin-dash__stats">
        <Tile label="UTMA (Merrill)" value={c ? money(c.value) : '—'} sub={c ? `as of ${fullDate(c.asOf)}` : 'no statements yet'} />
        <Tile label="NY 529" value={n ? money(n.value) : '—'} sub={n ? `as of ${fullDate(n.asOf)}${n.contributionsYtd != null ? ` · ${money(n.contributionsYtd)} in this year` : ''}` : 'not live in MikeOS'} />
        <Tile label="UTMA Fee" value={c?.fees.rate12 != null ? `${c.fees.rate12.toFixed(2)}%` : c ? money(c.fees.allTime) : '—'} sub={c?.fees.rate12 != null ? 'a year, advisory' : 'paid so far'} />
        <Tile label="UTMA Income · Year" value={c ? money(c.income.ytd) : '—'} sub="kiddie tax above $2,700" />
      </div>
      <div className="fin-dash__grid">
        {c && (
          <section className="fin-dash__card fin-dash__card--full">
            <DashTitle info={<p>Chase’s custodial account at Merrill: {c.strategy ?? '—'}. Statements are saved as “Merrill Lynch - YYYY.MM.DD - Chase.pdf” in the same Drive folder.</p>}>His UTMA</DashTitle>
            <MixBar a={c.allocation} height={14} />
            <MixLegend a={c.allocation} />
            <p className="fin-dash__note">
              {money(c.value)} as of {fullDate(c.asOf)} · money put in {money(c.flows.allTimeIn)} · return since {monthLabel(c.returns.net.sinceStart)} {pct(c.returns.net.since)} after fees (index mix {pct(c.returns.blend.since)}).
              {data.summary.insights.some((i) => i.key === 'data:chase') ? ' Only some of his statements are in Drive — add the rest to see a full history.' : ''}
            </p>
          </section>
        )}
        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle
            info={
              <>
                <p>Rules as of 2026 (IRS / Treasury guidance; NY 529 rules from the plan). Not tax advice — check limits each year.</p>
              </>
            }
          >
            Where Chase’s Money Could Go
          </DashTitle>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table ml-compare">
              <thead>
                <tr>
                  <th />
                  <th>NY 529</th>
                  <th>UTMA (now)</th>
                  <th>Trump Account</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Best for</td>
                  <td>College / school costs</td>
                  <td>Anything for Chase</td>
                  <td>Long-term (becomes an IRA at 18)</td>
                </tr>
                <tr>
                  <td>Tax break</td>
                  <td>NY deducts up to $10,000/yr (joint); growth tax-free for school</td>
                  <td>None — income taxed yearly (kiddie tax)</td>
                  <td>Grows tax-deferred; taxed like an IRA later</td>
                </tr>
                <tr>
                  <td>Yearly limit</td>
                  <td>Gift-tax rules ($19K per parent)</td>
                  <td>None</td>
                  <td>$5,000 total ($2,500 of it from an employer)</td>
                </tr>
                <tr>
                  <td>Whose money</td>
                  <td>Yours (you control it)</td>
                  <td>Chase’s, outright at 18</td>
                  <td>Chase’s; no withdrawals before 18</td>
                </tr>
                <tr>
                  <td>College aid (FAFSA)</td>
                  <td>Parent asset (counts ~5.6%)</td>
                  <td>Student asset (counts 20%)</td>
                  <td>Retirement-type account</td>
                </tr>
                <tr>
                  <td>Investments / cost</td>
                  <td>Low-cost index portfolios</td>
                  <td>Merrill advisory model{c?.fees.rate12 != null ? ` (${c.fees.rate12.toFixed(2)}%/yr)` : ''}</td>
                  <td>US stock index funds only, low fees</td>
                </tr>
              </tbody>
            </table>
          </div>
          <ul className="taxes-insights">
            <InsightRow i={{ key: 'c1', severity: 'info', area: 'chase', title: 'College first: the 529', detail: 'Each dollar you put in (up to $10,000 a year filing jointly) comes off your NY taxable income, and growth is tax-free for school. It stays your asset, which hurts aid the least.' }} />
            <InsightRow
              i={{
                key: 'c2',
                severity: 'info',
                area: 'chase',
                title: 'Trump Account: a head start on retirement',
                detail: 'Contributions opened July 4, 2026 (up to $5,000 a year from family, $2,500 of it from an employer). It must hold US stock index funds and converts to a traditional IRA at 18. Chase was born before 2025, so he doesn’t get the $1,000 government deposit.',
              }}
            />
            <InsightRow
              i={{
                key: 'c3',
                severity: 'warn',
                area: 'chase',
                title: 'The UTMA is the least flexible for you',
                detail: `It becomes Chase’s outright at 18, counts heavily against college aid, and its income is taxed every year (first $1,350 tax-free, the next $1,350 at his rate, above $2,700 at yours). New money usually fits better in the 529 or a Trump Account; what’s in the UTMA can only be spent for Chase.`,
              }}
            />
          </ul>
        </section>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- questions

function Questions({ data }: { data: Data }) {
  const s = data.summary;
  const [copied, setCopied] = useState(false);
  const lastReview = [...data.reviews].filter((r) => r.date).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))[0] ?? null;
  const areas: [MlInsight['area'], string][] = [
    ['performance', 'Performance'],
    ['fees', 'Fees'],
    ['allocation', 'Allocation'],
    ['taxes', 'Taxes'],
    ['retirement', 'Retirement'],
    ['chase', 'Chase'],
  ];
  const text = () =>
    [`Questions for our Merrill review (${fullDate(new Date().toISOString().slice(0, 10))})`, '', ...areas.flatMap(([k, l]) => {
      const qs = s.questions.filter((q) => q.area === k);
      return qs.length ? [l, ...qs.map((q) => `- ${q.text}`), ''] : [];
    })].join('\n');
  return (
    <div className="fin-dash__grid">
      <section className="fin-dash__card fin-dash__card--full">
        <div className="fin-dash__card-head">
          <DashTitle info={<p>Built from what the statements show (the Things to Check list) plus a few standing questions. They update every month. Copy them into your notes before a meeting.</p>}>For Your Next Advisor Meeting</DashTitle>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() =>
              copyText(text()).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              })
            }
          >
            {copied ? 'Copied ✓' : 'Copy Questions'}
          </button>
        </div>
        {lastReview && (
          <p className="fin-dash__muted">
            Last review in Drive: {fullDate(lastReview.date)}
            {lastReview.url ? (
              <>
                {' '}
                ·{' '}
                <a href={lastReview.url} target="_blank" rel="noreferrer">
                  Open
                </a>
              </>
            ) : null}
          </p>
        )}
        {areas.map(([k, label]) => {
          const qs = s.questions.filter((q) => q.area === k);
          if (!qs.length) return null;
          return (
            <div key={k} className="dash-sheet__section">
              <h4>{label}</h4>
              <ol className="ml-questions">
                {qs.map((q, i) => (
                  <li key={i}>{q.text}</li>
                ))}
              </ol>
            </div>
          );
        })}
      </section>
      {data.reviews.length > 0 && (
        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle info={<p>Portfolio / Client Review PDFs in the Drive folder (kept, not read).</p>}>Past Reviews</DashTitle>
          <ul className="credit-mini">
            {[...data.reviews].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).map((r) => (
              <li key={r.name}>
                <span>{r.date ? fullDate(r.date) : r.name}</span>
                <span>{r.url ? <a href={r.url} target="_blank" rel="noreferrer">Open</a> : null}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- statements

function Statements({ data, onSheet }: { data: Data; onSheet: (s: Sheet) => void }) {
  const s = data.summary;
  const files = new Map(data.files.map((f) => [f.fileId, f]));
  const unread = data.files.filter((f) => f.status === 'unreadable' || f.status === 'failed');
  return (
    <div className="fin-dash__grid">
      <section className="fin-dash__card fin-dash__card--full">
        <DashTitle info={<p>Every statement read from the Drive folder, newest first, with how many of its own math checks passed (opening + activity = closing per account, holdings add up, lots match positions, fees, trades, realized gains).</p>}>Statements</DashTitle>
        {unread.length > 0 && <p className="fin-dash__note">⚠ {unread.length} file(s) couldn’t be read: {unread.map((f) => f.name).join(', ')}</p>}
        <ul className="credit-mini">
          {[...s.statements].reverse().map((st) => (
            <li key={st.id}>
              <button type="button" className="ml-dash__link" onClick={() => onSheet({ kind: 'statement', id: st.id })}>
                {fullDate(st.date)}
                {st.kind === 'chase' ? ' · Chase' : ''}
              </button>
              <span>
                <strong>{money(st.total)}</strong>
                <span className={`fin-dash__muted${st.checkOk < st.checkCount ? ' bee-delta--down' : ''}`}>
                  {' '}
                  · {st.partial ? 'summary only' : `${st.checkOk}/${st.checkCount} checks`}
                </span>
                {files.get(st.fileId)?.url && (
                  <>
                    {' '}
                    ·{' '}
                    <a href={files.get(st.fileId)!.url!} target="_blank" rel="noreferrer">
                      PDF
                    </a>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
        <p className="fin-dash__muted">
          Benchmarks: {data.market.months ? `${data.market.months} months of index prices (${monthLabel(data.market.first)} – ${monthLabel(data.market.last)})` : 'not loaded yet'}
          {data.market.fetchedAt ? ` · updated ${fullDate(data.market.fetchedAt)}` : ''}
          {data.market.error ? ` · last try: ${data.market.error}` : ''}
        </p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- sheets

function SheetView({ sheet, data, onClose }: { sheet: NonNullable<Sheet>; data: Data; onClose: () => void }) {
  const s = data.summary;
  if (sheet.kind === 'insight') {
    const i = s.insights.find((x) => x.key === sheet.key);
    if (!i) return null;
    return (
      <DetailSheet title={i.title} onClose={onClose}>
        <p>{i.detail}</p>
        {i.question && (
          <div className="dash-sheet__section">
            <h4>Ask Your Advisor</h4>
            <p>{i.question}</p>
          </div>
        )}
      </DetailSheet>
    );
  }
  if (sheet.kind === 'holding') {
    const h = s.holdings.find((x) => x.key === sheet.key) as MlMergedHolding | undefined;
    if (!h) return null;
    return (
      <DetailSheet title={`${h.symbol ? `${h.symbol} · ` : ''}${titleCase(h.name)}`} sub={`${money(h.value)} · ${pct(h.pct)} of the household`} onClose={onClose}>
        <ul className="credit-mini">
          {h.accounts.map((a) => (
            <li key={a.last4}>
              <span>{typeShort(a.type)} ••{a.last4}</span>
              <span>{money(a.value)}</span>
            </li>
          ))}
        </ul>
        <p className="fin-dash__muted">
          Gain {money(h.gain)} · est. income {money(h.income)}/yr · {Math.round(h.classes.equity * 100)}% stocks{h.classes.fixed ? ` · ${Math.round(h.classes.fixed * 100)}% bonds` : ''}
          {h.intl ? ' · international' : ''}
        </p>
      </DetailSheet>
    );
  }
  if (sheet.kind === 'statement') {
    const st = s.statements.find((x) => x.id === sheet.id);
    if (!st) return null;
    const file = data.files.find((f) => f.fileId === st.fileId);
    return (
      <DetailSheet title={`${fullDate(st.date)} Statement`} sub={st.kind === 'chase' ? 'Chase’s UTMA' : `${money(st.total)} household`} onClose={onClose}>
        <ul className="credit-mini">
          {st.accounts.map((a) => (
            <li key={a.last4}>
              <span>
                {typeShort(a.type)} ••{a.last4}
              </span>
              <span>{money(a.value)}</span>
            </li>
          ))}
        </ul>
        <div className="dash-sheet__section">
          <h4>
            Checks {st.checkOk}/{st.checkCount}
          </h4>
          <ul className="credit-mini">
            {st.checks.map((c, i) => (
              <li key={i}>
                <span className={c.ok ? undefined : 'bee-delta--down'}>
                  {c.ok ? '✓' : '✗'} {c.name}
                </span>
                <span className="fin-dash__muted">{c.detail}</span>
              </li>
            ))}
          </ul>
        </div>
        {file?.url && (
          <p>
            <a href={file.url} target="_blank" rel="noreferrer">
              Open PDF
            </a>
          </p>
        )}
      </DetailSheet>
    );
  }
  // account
  const a = sheet.number === 'household' ? s.household : allAccounts(s).find((x) => x.number === sheet.number);
  if (!a) return null;
  const holdings: MlHolding[] = a.holdings;
  return (
    <DetailSheet title={sheet.number === 'household' ? 'All Household Accounts' : `${a.label} ••${a.last4}`} sub={`${money(a.value)} as of ${fullDate(a.asOf)}${a.strategy ? ` · ${a.strategy}` : ''}`} onClose={onClose}>
      <FinanceLineChart ariaLabel="Value over time" formatX={fmtYear} formatY={(v) => compact(v)} series={[{ name: 'Value', color: C_NET, points: a.series.map((p) => ({ x: dateX(p.date), y: p.value })) }]} />
      <MixBar a={a.allocation} height={12} />
      <MixLegend a={a.allocation} />
      <div className="dash-sheet__section">
        <h4>Returns After Fees (vs Same-Mix Index Funds)</h4>
        <ul className="credit-mini">
          {(
            [
              ['YTD', 'ytd'],
              ['1 Year', 'y1'],
              ['3 Years / yr', 'y3'],
              ['5 Years / yr', 'y5'],
              ['Since Start / yr', 'since'],
            ] as const
          ).map(([l, k]) => (
            <li key={k}>
              <span>{l}</span>
              <span>
                <strong>{pct(a.returns.net[k])}</strong>
                <span className="fin-dash__muted"> · mix {pct(a.returns.blend[k])}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="dash-sheet__section">
        <h4>Money</h4>
        <ul className="credit-mini">
          <li>
            <span>Put in (all time)</span>
            <span>{money(a.flows.allTimeIn)}</span>
          </li>
          {a.flows.allTimeOut ? (
            <li>
              <span>Taken out</span>
              <span>{money(a.flows.allTimeOut)}</span>
            </li>
          ) : null}
          <li>
            <span>Fees (12 mo)</span>
            <span>
              {money(a.fees.trailing12)}
              {a.fees.rate12 !== null ? ` · ${a.fees.rate12.toFixed(2)}%` : ''}
            </span>
          </li>
          <li>
            <span>Dividends & interest (12 mo)</span>
            <span>{money(a.income.last12)}</span>
          </li>
          {a.rollovers.map((r) => (
            <li key={r.year}>
              <span>Rollover deposits {r.year}</span>
              <span>{money(r.amount)}</span>
            </li>
          ))}
        </ul>
      </div>
      {holdings.length > 0 && (
        <div className="dash-sheet__section">
          <h4>Holdings ({holdings.length})</h4>
          <ul className="credit-mini">
            {holdings.slice(0, 60).map((h, i) => (
              <li key={`${h.symbol ?? h.name}-${i}`}>
                <span>
                  {h.symbol && <strong>{h.symbol} </strong>}
                  <span className="fin-dash__muted">{titleCase(h.name)}</span>
                </span>
                <span>{money(h.value)}</span>
              </li>
            ))}
          </ul>
          {holdings.length > 60 && <p className="fin-dash__muted">+ {holdings.length - 60} more (Allocation tab lists everything).</p>}
        </div>
      )}
    </DetailSheet>
  );
}

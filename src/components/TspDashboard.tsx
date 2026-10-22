import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { TspDashboard as Data, TspInsight, TspYear } from '../api/types';
import { FinanceLineChart } from './FinanceLineChart';
import { DashTitle } from './dash/InfoTip';
import { DetailSheet } from './dash/DetailSheet';
import { SectionPicker } from './dash/SectionPicker';

/** Finance → Thrift Savings Plan (Mike, 2026-10-22): the uniformed-services
 * TSP from his military years — quarterly + annual statements since 2004,
 * read by the worker (templates/tsp.ts → tspSummary.ts). Balance and
 * returns, what each TSP fund did, "what if it had been in…", which funds
 * held the money when, the target-date fit, what went in and what it costs.
 * Every return here is in percent (14.3 = 14.3%). */

type Tab = 'overview' | 'performance' | 'whatif' | 'funds' | 'money' | 'statements';
const TABS: [Tab, string][] = [
  ['overview', 'Overview'],
  ['performance', 'Performance'],
  ['whatif', 'What If'],
  ['funds', 'Funds'],
  ['money', 'Money In & Costs'],
  ['statements', 'Statements'],
];

type Sheet = { kind: 'insight'; key: string } | { kind: 'year'; year: number } | { kind: 'statement'; id: string } | { kind: 'value' } | null;

const C_YOU = '#2A6FB0';
const C_TWO = '#C0662E';
const C_THREE = '#7A5BB5';
const C_GREY = '#8A8F98';

const money = (n: number | null | undefined) => (n == null ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`);
const money2 = (n: number | null | undefined) => (n == null ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct = (x: number | null | undefined, d = 1) => (x == null ? '—' : `${x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}%`);
const fullDate = (iso: string | null | undefined) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—');
const dateX = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10) || '15'));
const fmtYear = (ms: number) => String(new Date(ms).getUTCFullYear());
const tone = (x: number | null | undefined) => (x == null ? undefined : x >= 0 ? 'bee-delta--up' : 'bee-delta--down');
const sevRank = (i: TspInsight) => (i.severity === 'warn' ? 0 : i.severity === 'info' ? 1 : 2);
const KIND_LABEL = { quarterly: 'Quarterly', annual: 'Annual', interim: 'On Demand' } as const;

export function TspDashboard({ data, onDismissFlag }: { data: Data; onDismissFlag: (id: string) => void }) {
  const [params, setParams] = useSearchParams();
  const [sheet, setSheet] = useState<Sheet>(null);
  const tab = (TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'overview') as Tab;
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t === 'overview') next.delete('tab');
    else next.set('tab', t);
    setParams(next, { replace: true });
  };
  const tabs = TABS.filter(([k]) => k !== 'whatif' || data.summary.whatIf);

  return (
    <div className="fin-dash ml-dash tsp-dash">
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
      {tab === 'performance' && <Performance data={data} onSheet={setSheet} />}
      {tab === 'whatif' && <WhatIf data={data} />}
      {tab === 'funds' && <Funds data={data} />}
      {tab === 'money' && <MoneyIn data={data} />}
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

function InsightRow({ i, onOpen }: { i: TspInsight; onOpen: () => void }) {
  return (
    <li className={`taxes-insight taxes-insight--${i.severity}`}>
      <span className="taxes-insight__icon">{i.severity === 'good' ? '✓' : i.severity === 'warn' ? '⚠' : 'ⓘ'}</span>
      <span className="taxes-insight__body">
        <button type="button" className="ml-dash__link" onClick={onOpen}>
          <strong>{i.title}</strong>
        </button>
        <span className="fin-dash__muted">{i.detail}</span>
      </span>
    </li>
  );
}

function FundBar({ mix }: { mix: { fund: string; pct: number }[] }) {
  const colors = [C_YOU, C_TWO, C_THREE, C_GREY];
  return (
    <div className="ml-mix" style={{ height: 10 }} role="img" aria-label={mix.map((m) => `${m.fund} ${Math.round(m.pct)}%`).join(', ')}>
      {mix.map((m, i) => (
        <span key={m.fund} title={`${m.fund} ${Math.round(m.pct)}%`} style={{ width: `${m.pct}%`, background: colors[i % colors.length] }} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- overview

function Overview({ data, onSheet, onTab }: { data: Data; onSheet: (s: Sheet) => void; onTab: (t: Tab) => void }) {
  const s = data.summary;
  const r = s.returns;
  const held = s.vsFunds.find((f) => f.held);
  const ordered = [...s.insights].sort((a, b) => sevRank(a) - sevRank(b));
  const putIn = (() => {
    // Money put in, as a step line: dated contributions + the lifetime total once reached.
    let cum = 0;
    const pts: { x: number; y: number }[] = [];
    for (const p of s.points) {
      const listed = s.contributions.list.filter((c) => c.date <= p.date).reduce((t, c) => t + c.amount, 0);
      const inferred = s.inferred && p.date >= s.inferred.to ? s.inferred.amount : 0;
      cum = Math.min(s.contributions.lifetime, listed + inferred);
      pts.push({ x: dateX(p.date), y: cum });
    }
    return pts;
  })();
  return (
    <>
      <div className="fin-dash__stats fin-dash__stats--5">
        <Tile label="Balance" value={money2(s.balance)} sub={`as of ${fullDate(s.asOf)}`} onClick={() => onSheet({ kind: 'value' })} />
        <Tile label="1-Year Return" value={<span className={tone(r?.y1)}>{pct(r?.y1)}</span>} sub={held ? `${held.fund} printed ${pct(held.y1)}` : 'time-weighted'} onClick={() => onTab('performance')} />
        <Tile label={`Since ${r?.sinceDate?.slice(0, 4) ?? 'Start'} / yr`} value={<span className={tone(r?.since)}>{pct(r?.since)}</span>} sub={r?.y10 != null ? `10 years ${pct(r.y10)}/yr` : ''} onClick={() => onTab('performance')} />
        <Tile label="Money Put In" value={money2(s.contributions.lifetime)} sub={s.contributions.multiple ? `now ${s.contributions.multiple.toFixed(1)}× · ${money(s.contributions.growth)} growth` : ''} onClick={() => onTab('money')} />
        <Tile label="Cost / Year" value={money2(s.costs.perYear)} sub={s.costs.rate !== null ? `${s.costs.rate.toFixed(3)}% expense ratio` : ''} onClick={() => onTab('money')} />
      </div>

      <div className="fin-dash__grid">
        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle info={<p>Rule-based checks on your TSP statements: beneficiary, how your target-date fund fits your retirement age, growth, cost and missing statements. Not financial advice.</p>}>Things to Check</DashTitle>
          <ul className="taxes-insights">
            {ordered.map((i) => (
              <InsightRow key={i.key} i={i} onOpen={() => onSheet({ kind: 'insight', key: i.key })} />
            ))}
          </ul>
        </section>

        <section className="fin-dash__card fin-dash__card--wide">
          <DashTitle info={<p>Each statement’s closing balance since your first contribution, and the money you put in (contributions only — nothing has been withdrawn). The gap is what the investments earned.</p>}>Value Over Time</DashTitle>
          <FinanceLineChart
            ariaLabel="TSP balance and money put in"
            formatX={fmtYear}
            formatY={(v) => money(v)}
            series={[
              { name: 'Balance', color: C_YOU, points: s.points.map((p) => ({ x: dateX(p.date), y: p.value })) },
              { name: 'Money Put In', color: C_GREY, step: true, points: putIn },
            ]}
          />
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>Where the money is today and where new money (contributions or transfers in) would go. An election only steers new money — moving what’s already there takes an interfund transfer.</p>}>Invested In</DashTitle>
          {s.current.length > 0 && <FundBar mix={s.current} />}
          <ul className="credit-mini">
            {s.current.map((f) => (
              <li key={f.fund}>
                <span>
                  <strong>{f.fund}</strong> {Math.round(f.pct)}%
                </span>
                <span>
                  {money2(f.value)}
                  {f.shares !== null && f.price !== null && <span className="fin-dash__muted"> · {f.shares} sh @ ${f.price.toFixed(4)}</span>}
                </span>
              </li>
            ))}
            <li>
              <span>New money goes to</span>
              <span>{s.election ? Object.entries(s.election).map(([f, p]) => `${f} ${p}%`).join(' · ') : '—'}</span>
            </li>
            <li>
              <span>Beneficiary</span>
              <span className={s.beneficiary === false ? 'bee-delta--down' : undefined}>{s.beneficiary === false ? 'None designated' : s.beneficiary ? 'Designated' : '—'}</span>
            </li>
            <li>
              <span>Tax treatment</span>
              <span>{s.contributions.roth ? `Traditional + Roth` : 'Traditional (pre-tax)'}</span>
            </li>
          </ul>
          {data.template?.site && (
            <p className="fin-dash__muted">
              <a href={data.template.site} target="_blank" rel="noreferrer">
                tsp.gov My Account
              </a>{' '}
              · ThriftLine {data.template.phone}
            </p>
          )}
        </section>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- performance

function Performance({ data, onSheet }: { data: Data; onSheet: (s: Sheet) => void }) {
  const s = data.summary;
  const r = s.returns;
  const core = s.vsFunds.filter((f) => f.held || /^[GFCSI] Fund$/.test(f.fund));
  const growth = s.points.filter((p) => p.date >= (r?.sinceDate ?? '')).map((p) => ({ x: dateX(p.date), y: (p.index / (s.points.find((q) => q.date === r?.sinceDate)?.index ?? 1)) * 10000 }));
  const yrs = [...s.years].reverse();
  const recent = s.periods.slice(-12);
  const maxAbs = Math.max(1, ...recent.map((p) => Math.abs(p.ret ?? 0)));
  return (
    <div className="fin-dash__grid">
      <section className="fin-dash__card fin-dash__card--full">
        <DashTitle
          info={
            <>
              <p>
                <strong>Your account</strong> is time-weighted from the statements (contributions don’t count as gains); 3, 5, 10 years and “Start” are per year. The fund rows are the TSP’s own published returns, as printed on your latest statement
                {s.vsFundsAsOf ? ` (as of ${fullDate(s.vsFundsAsOf)})` : ''}.
              </p>
              <p>With all the money in one fund, your return should match that fund’s — a good check the statements were read right.</p>
            </>
          }
        >
          Returns
        </DashTitle>
        <div className="fin-dash__table-wrap">
          <table className="fin-dash__table ml-ret tsp-ret">
            <thead>
              <tr>
                <th />
                <th className="num">YTD</th>
                <th className="num">1Y</th>
                <th className="num">3Y</th>
                <th className="num">5Y</th>
                <th className="num">10Y</th>
                <th className="num">Start</th>
              </tr>
            </thead>
            <tbody>
              <tr className="tsp-ret--you">
                <td>Your account</td>
                <td className="num">{pct(r?.ytd)}</td>
                <td className="num">{pct(r?.y1)}</td>
                <td className="num">{pct(r?.y3)}</td>
                <td className="num">{pct(r?.y5)}</td>
                <td className="num">{pct(r?.y10)}</td>
                <td className="num">{pct(r?.since)}</td>
              </tr>
              {core.map((f) => (
                <tr key={f.fund} className={f.held ? 'tsp-ret--held' : undefined}>
                  <td>
                    {f.fund}
                    {f.held ? ' (yours)' : ''}
                  </td>
                  <td className="num">{pct(f.ytd)}</td>
                  <td className="num">{pct(f.y1)}</td>
                  <td className="num">{pct(f.y3)}</td>
                  <td className="num">{pct(f.y5)}</td>
                  <td className="num">—</td>
                  <td className="num">—</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="fin-dash__card fin-dash__card--wide">
        <DashTitle info={<p>What $10,000 would have become following your account’s returns since {r?.sinceDate?.slice(0, 4)} — contributions don’t move this line.</p>}>Growth of $10,000</DashTitle>
        <FinanceLineChart ariaLabel="Growth of $10,000" formatX={fmtYear} formatY={(v) => money(v)} series={[{ name: 'Your account', color: C_YOU, points: growth }]} />
      </section>

      <section className="fin-dash__card">
        <DashTitle info={<p>Return for each statement period, most recent last (usually a quarter; on-demand statements make a few short periods in 2022–23).</p>}>Last 12 Periods</DashTitle>
        <ul className="tsp-bars">
          {recent.map((p) => (
            <li key={p.to}>
              <span className="tsp-bars__label">{fullDate(p.to)}</span>
              <span className="tsp-bars__track">
                <span className={`tsp-bars__bar ${(p.ret ?? 0) >= 0 ? 'tsp-bars__bar--up' : 'tsp-bars__bar--down'}`} style={{ width: `${(Math.abs(p.ret ?? 0) / maxAbs) * 100}%` }} />
              </span>
              <span className={`tsp-bars__value ${tone(p.ret) ?? ''}`}>{pct(p.ret)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="fin-dash__card fin-dash__card--full">
        <DashTitle info={<p>Calendar years from the statements. “TSP Printed” is the personal rate of return on that year’s annual statement. The fund columns are each TSP fund’s 1-year return printed that year (from 2012). Tap a year for detail.</p>}>By Year</DashTitle>
        <div className="fin-dash__table-wrap post-table">
          <table className="fin-dash__table">
            <thead>
              <tr>
                <th>Year</th>
                <th className="num">Start</th>
                <th className="num">End</th>
                <th className="num">Gain</th>
                <th className="num">Return</th>
                <th className="num">TSP Printed</th>
                <th className="num">L 2040</th>
                <th className="num">C</th>
                <th className="num">S</th>
                <th className="num">I</th>
                <th className="num">G</th>
              </tr>
            </thead>
            <tbody>
              {yrs.map((y) => (
                <tr key={y.year} className="tsp-row" onClick={() => onSheet({ kind: 'year', year: y.year })}>
                  <td>
                    {y.year}
                    {y.partial ? ' (part)' : ''}
                  </td>
                  <td className="num">{money2(y.start)}</td>
                  <td className="num">{money2(y.end)}</td>
                  <td className={`num ${tone(y.gain) ?? ''}`}>{money2(y.gain)}</td>
                  <td className={`num ${tone(y.ret) ?? ''}`}>{pct(y.ret)}</td>
                  <td className="num fin-dash__muted">{pct(y.printed)}</td>
                  {['L 2040', 'C Fund', 'S Fund', 'I Fund', 'G Fund'].map((f) => (
                    <td key={f} className="num fin-dash__muted">
                      {pct(y.funds[f] ?? null)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="post-cards">
          {yrs.map((y) => (
            <li key={y.year}>
              <button type="button" className="post-card" onClick={() => onSheet({ kind: 'year', year: y.year })}>
                <span className="post-card__top">
                  {y.year}
                  {y.partial ? ' (part of year)' : ''}
                  <span className={`ml-card__right ${tone(y.ret) ?? ''}`}>{pct(y.ret)}</span>
                </span>
                <span className="ml-card__nums">
                  {money2(y.start)} → {money2(y.end)} · <span className={tone(y.gain)}>{money2(y.gain)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- what if

function WhatIf({ data }: { data: Data }) {
  const s = data.summary;
  const w = s.whatIf!;
  const held = s.current[0]?.fund ?? 'L 2040';
  const pick = ['C/S 50/50', held, 'G Fund'];
  const colors = [C_TWO, C_THREE, C_GREY];
  const x0 = dateX(w.from);
  const toPts = (vals: { year: number; value: number }[]) => [{ x: x0, y: w.start }, ...vals.map((v) => ({ x: dateX(v.year === Number(s.asOf?.slice(0, 4)) && s.asOf ? s.asOf : `${v.year}-12-31`), y: v.value }))];
  const lines = pick.map((f, i) => ({ f, i, line: w.lines.find((l) => l.fund === f) })).filter((x) => x.line);
  const ranked = [...w.lines].sort((a, b) => b.end - a.end);
  const actualEnd = w.actual[w.actual.length - 1]?.value ?? s.balance;
  const switchInsight = s.insights.find((i) => i.key === 'switch');
  return (
    <div className="fin-dash__grid">
      <section className="fin-dash__card fin-dash__card--wide">
        <DashTitle
          info={
            <p>
              Your balance at the end of {w.from.slice(0, 4)} ({money2(w.start)}) grown by each TSP fund’s yearly return as printed on your annual statements, vs what you actually have. “C/S 50/50” is the mix you held until 2018, rebalanced yearly. Ignores timing inside each year.
              {w.ytdNote ? ` ${w.ytdNote}.` : ''}
            </p>
          }
        >
          If It Had Been In…
        </DashTitle>
        <FinanceLineChart
          ariaLabel="What if the money had been in other TSP funds"
          formatX={fmtYear}
          formatY={(v) => money(v)}
          series={[{ name: 'What you have', color: C_YOU, points: toPts(w.actual) }, ...lines.map(({ f, i, line }) => ({ name: f, color: colors[i], points: toPts(line!.values) }))]}
        />
      </section>

      <section className="fin-dash__card">
        <DashTitle info={<p>Every fund with a full run of yearly returns since {w.years[0]}, ending value today. Your actual result moved from C/S to {held} in 2018.</p>}>Ending Value by Fund</DashTitle>
        <ul className="credit-mini">
          {ranked.map((l) => (
            <li key={l.fund}>
              <span>
                {l.fund}
                {l.fund === held ? ' (yours now)' : l.fund === 'C/S 50/50' ? ' (yours to 2018)' : ''}
              </span>
              <span>
                <strong>{money(l.end)}</strong> <span className={`fin-dash__muted ${tone(l.end - actualEnd) ?? ''}`}>{money(l.end - actualEnd)}</span>
              </span>
            </li>
          ))}
          <li>
            <span>
              <strong>What you have</strong>
            </span>
            <span>
              <strong>{money(actualEnd)}</strong>
            </span>
          </li>
        </ul>
        {switchInsight && <p className="fin-dash__muted">{switchInsight.detail}</p>}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- funds

function Funds({ data }: { data: Data }) {
  const s = data.summary;
  const t = s.target;
  const navFund = s.current[0]?.fund ?? null;
  const nav = navFund ? s.navs[navFund] ?? [] : [];
  const core = s.vsFunds.filter((f) => /^[GFCSI] Fund$/.test(f.fund));
  const DESC: Record<string, string> = {
    'G Fund': 'Government securities — never loses value; tracks Treasury rates',
    'F Fund': 'US bond index (investment grade)',
    'C Fund': 'S&P 500 — large US companies',
    'S Fund': 'US small and mid companies (everything outside the S&P 500)',
    'I Fund': 'International stocks (developed and emerging markets)',
  };
  return (
    <div className="fin-dash__grid">
      <section className="fin-dash__card fin-dash__card--full">
        <DashTitle info={<p>L (Lifecycle) funds are target-date mixes of the five core funds: they hold mostly stocks early on and shift toward the G and F funds each quarter as the target year nears, then fold into L Income. Pick the one nearest the year you expect to start withdrawing.</p>}>
          Target-Date Fit
        </DashTitle>
        <div className="fin-dash__stats">
          <Tile label="Your Fund" value={t.current ?? '—'} sub={t.ageAtFundDate !== null && t.current?.startsWith('L 20') ? `you’d be ${t.ageAtFundDate} in ${t.current.slice(2)}` : ''} />
          <Tile label="Retire At" value={t.retireAge} sub={t.targetYear ? `around ${t.targetYear}${t.age !== null ? ` · you’re ${t.age}` : ''}` : 'needs your birth date (Social Security)'} />
          <Tile label="Closest L Fund" value={t.suggested ?? '—'} sub={t.suggested && t.suggested === t.current ? 'matches' : t.suggested ? 'free interfund transfer on tsp.gov' : ''} />
        </div>
        <p className="fin-dash__muted">The retirement age is the one on Finance → Merrill Lynch → Retirement (change it there).</p>
        {t.lFunds.length > 0 && (
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table ml-ret">
              <thead>
                <tr>
                  <th>L Fund</th>
                  <th className="num">YTD</th>
                  <th className="num">1Y</th>
                  <th className="num">3Y</th>
                  <th className="num">5Y</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {t.lFunds.map((f) => (
                  <tr key={f.fund} className={f.fund === t.current ? 'tsp-ret--held' : f.fund === t.suggested ? 'tsp-ret--fit' : undefined}>
                    <td>
                      {f.fund}
                      {f.fund === t.current ? ' (yours)' : f.fund === t.suggested ? ' (fits)' : ''}
                    </td>
                    <td className="num">{pct(f.ytd)}</td>
                    <td className="num">{pct(f.y1)}</td>
                    <td className="num">{pct(f.y3)}</td>
                    <td className="num">{pct(f.y5)}</td>
                    <td className="num fin-dash__muted">{f.expense !== null ? `${f.expense.toFixed(3)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="fin-dash__muted">As printed by the TSP {t.asOf ? `(as of ${fullDate(t.asOf)})` : ''}.</p>
      </section>

      <section className="fin-dash__card fin-dash__card--wide">
        <DashTitle info={<p>Which funds held the money, from the statements. New money went where the election pointed; on {s.transfers.find((x) => x.amount > 0 && x.fund.startsWith('L'))?.date ?? '—'} it all moved to an L fund with one interfund transfer.</p>}>Fund History</DashTitle>
        <ul className="tsp-eras">
          {[...s.eras].reverse().map((e) => (
            <li key={e.from}>
              <span className="tsp-eras__when">
                {fullDate(e.from)} – {e.to === s.asOf ? 'today' : fullDate(e.to)}
              </span>
              <FundBar mix={e.mix} />
              <span className="fin-dash__muted">{e.mix.map((m) => `${m.fund} ${Math.round(m.pct)}%`).join(' · ')}</span>
            </li>
          ))}
        </ul>
        {s.transfers.length > 0 && (
          <>
            <h4 className="tsp-sub">Interfund Transfers</h4>
            <ul className="credit-mini">
              {s.transfers.map((x, i) => (
                <li key={i}>
                  <span>
                    {fullDate(x.date)} · {x.fund}
                  </span>
                  <span className={tone(x.amount)}>
                    {money2(x.amount)}
                    {x.units !== null && <span className="fin-dash__muted"> · {x.units} sh</span>}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {nav.length > 1 && (
        <section className="fin-dash__card">
          <DashTitle info={<p>The fund’s share price (NAV) on each statement. Your share count hasn’t changed since the transfer, so the balance moves exactly with this price — TSP funds don’t pay out dividends; earnings stay in the price.</p>}>{navFund} Share Price</DashTitle>
          <FinanceLineChart ariaLabel={`${navFund} share price`} formatX={fmtYear} formatY={(v) => `$${v.toFixed(0)}`} yFromZero={false} series={[{ name: navFund!, color: C_THREE, points: nav.map((p) => ({ x: dateX(p.date), y: p.price })) }]} />
        </section>
      )}

      {core.length > 0 && (
        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle info={<p>The five core TSP funds every L fund is built from, with the TSP’s published returns.</p>}>The Core Funds</DashTitle>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table ml-ret">
              <thead>
                <tr>
                  <th>Fund</th>
                  <th className="num">YTD</th>
                  <th className="num">1Y</th>
                  <th className="num">3Y</th>
                  <th className="num">5Y</th>
                </tr>
              </thead>
              <tbody>
                {core.map((f) => (
                  <tr key={f.fund}>
                    <td>
                      <strong>{f.fund}</strong> <span className="fin-dash__muted tsp-desc">{DESC[f.fund]}</span>
                    </td>
                    <td className="num">{pct(f.ytd)}</td>
                    <td className="num">{pct(f.y1)}</td>
                    <td className="num">{pct(f.y3)}</td>
                    <td className="num">{pct(f.y5)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- money in & costs

function MoneyIn({ data }: { data: Data }) {
  const s = data.summary;
  const c = s.contributions;
  const cost = s.costs;
  return (
    <>
      <div className="fin-dash__stats">
        <Tile label="You Put In" value={money2(c.lifetime)} sub={c.first ? `${c.first.slice(0, 4)}–${(c.last ?? c.first).slice(0, 4)}` : ''} />
        <Tile label="Employer" value={money2(c.employer)} sub="no matching (pre-2018 uniformed services)" />
        <Tile label="Growth" value={money2(c.growth)} sub={c.multiple ? `${c.multiple.toFixed(1)}× what went in` : ''} />
        <Tile label="All-Time Cost" value={money2(cost.allTime)} sub={cost.history.length ? `since ${cost.history[0].year}, from printed expense ratios` : ''} />
      </div>
      <div className="fin-dash__grid">
        <section className="fin-dash__card">
          <DashTitle info={<p>Payroll contributions listed on the statements (all traditional, pre-tax). The lifetime figure is what the TSP prints; {s.inferred ? `${money2(s.inferred.amount)} of it falls in a quarter with no statement in Drive.` : 'it matches the statements.'}</p>}>Contributions</DashTitle>
          <ul className="credit-mini">
            {c.list.map((x) => (
              <li key={x.date}>
                <span>{fullDate(x.date)}</span>
                <span>{money2(x.amount)}</span>
              </li>
            ))}
            {s.inferred && (
              <li>
                <span className="fin-dash__muted">
                  {fullDate(s.inferred.from)} – {fullDate(s.inferred.to)} (no statement)
                </span>
                <span className="fin-dash__muted">{money2(s.inferred.amount)}</span>
              </li>
            )}
            <li>
              <span>
                <strong>Lifetime</strong>
              </span>
              <span>
                <strong>{money2(c.lifetime)}</strong>
              </span>
            </li>
          </ul>
          <p className="fin-dash__muted">Traditional money is taxed as income when it comes out (no 10% early-withdrawal penalty after 59½). Nothing to report on taxes while it sits.</p>
        </section>

        <section className="fin-dash__card fin-dash__card--wide">
          <DashTitle info={<p>What this balance costs a year at each expense rate, and the gap over 10 years at a 7% return. TSP fees come out of the fund’s price — you never see a bill.</p>}>What It Costs</DashTitle>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table tsp-cost">
              <thead>
                <tr>
                  <th />
                  <th className="num">Rate</th>
                  <th className="num">Per Year</th>
                  <th className="num">10-Year Drag</th>
                </tr>
              </thead>
              <tbody>
                {cost.compare.map((x, i) => (
                  <tr key={x.label} className={i === 0 ? 'tsp-ret--held' : undefined}>
                    <td>{x.label}</td>
                    <td className="num">{x.rate.toFixed(x.rate < 0.1 ? 3 : 2)}%</td>
                    <td className="num">{money2(x.perYear)}</td>
                    <td className="num">{money(x.tenYears)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cost.history.length > 0 && (
            <>
              <h4 className="tsp-sub">Expense Ratio by Year</h4>
              <ul className="credit-mini">
                {[...cost.history].reverse().map((h) => (
                  <li key={h.year}>
                    <span>{h.year}</span>
                    <span>
                      {h.rate !== null ? `${h.rate.toFixed(3)}%` : '—'} <span className="fin-dash__muted">· {money2(h.dollars)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- statements

function Statements({ data, onSheet }: { data: Data; onSheet: (s: Sheet) => void }) {
  const s = data.summary;
  const files = new Map(data.files.map((f) => [f.fileId, f]));
  const unread = data.files.filter((f) => f.status === 'unreadable' || f.status === 'failed');
  const dups = data.files.filter((f) => f.status === 'duplicate');
  return (
    <div className="fin-dash__grid">
      <section className="fin-dash__card fin-dash__card--full">
        <DashTitle info={<p>Every statement read from the Drive folder, newest first, with how many of its own math checks passed (opening + contributions + gain = closing, funds add up, shares × price = balance). Six layouts since 2004 are read.</p>}>Statements</DashTitle>
        {unread.length > 0 && <p className="fin-dash__note">⚠ {unread.length} file(s) couldn’t be read: {unread.map((f) => f.name).join(', ')}</p>}
        {dups.length > 0 && <p className="fin-dash__muted">Duplicates (same period as another file): {dups.map((f) => f.name).join(', ')}</p>}
        <ul className="credit-mini">
          {[...s.statements].reverse().map((st) => {
            const ok = st.checks.filter((c) => c.ok).length;
            return (
              <li key={st.id}>
                <button type="button" className="ml-dash__link" onClick={() => onSheet({ kind: 'statement', id: st.id })}>
                  {fullDate(st.date)} · {KIND_LABEL[st.kind]}
                </button>
                <span>
                  <strong>{money2(st.closing)}</strong>
                  <span className={`fin-dash__muted${ok < st.checks.length ? ' bee-delta--down' : ''}`}>
                    {' '}
                    · {ok}/{st.checks.length} checks
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
            );
          })}
        </ul>
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
        {i.key === 'beneficiary' && (
          <p>
            <a href="https://www.tsp.gov" target="_blank" rel="noreferrer">
              Open tsp.gov → My Account → Beneficiaries
            </a>
          </p>
        )}
      </DetailSheet>
    );
  }
  if (sheet.kind === 'value') {
    const recent = [...s.points].reverse().slice(0, 16);
    return (
      <DetailSheet title="Balance" sub={`${money2(s.balance)} as of ${fullDate(s.asOf)}`} onClose={onClose}>
        <FinanceLineChart ariaLabel="Balance over time" formatX={fmtYear} formatY={(v) => money(v)} series={[{ name: 'Balance', color: C_YOU, points: s.points.map((p) => ({ x: dateX(p.date), y: p.value })) }]} />
        <ul className="credit-mini">
          {recent.map((p) => (
            <li key={p.date}>
              <span>{fullDate(p.date)}</span>
              <span>{money2(p.value)}</span>
            </li>
          ))}
        </ul>
      </DetailSheet>
    );
  }
  if (sheet.kind === 'year') {
    const y = s.years.find((x) => x.year === sheet.year) as TspYear | undefined;
    if (!y) return null;
    const periods = s.periods.filter((p) => p.to > `${y.year - 1}-12-31` && p.to <= `${y.year}-12-31`);
    const funds = Object.entries(y.funds).sort((a, b) => (b[1] ?? -999) - (a[1] ?? -999));
    return (
      <DetailSheet title={`${y.year}${y.partial ? ' (part of year)' : ''}`} sub={`${money2(y.start)} → ${money2(y.end)} · ${pct(y.ret)}`} onClose={onClose}>
        <ul className="credit-mini">
          <li>
            <span>Gain</span>
            <span className={tone(y.gain)}>{money2(y.gain)}</span>
          </li>
          {y.contributions !== 0 && (
            <li>
              <span>Contributions</span>
              <span>{money2(y.contributions)}</span>
            </li>
          )}
          {y.printed !== null && (
            <li>
              <span>TSP’s printed personal return</span>
              <span>{pct(y.printed)}</span>
            </li>
          )}
        </ul>
        {periods.length > 0 && (
          <div className="dash-sheet__section">
            <h4>By Period</h4>
            <ul className="credit-mini">
              {periods.map((p) => (
                <li key={p.to}>
                  <span>
                    {fullDate(p.from)} → {fullDate(p.to)}
                  </span>
                  <span className={tone(p.ret)}>
                    {pct(p.ret)} <span className="fin-dash__muted">· {money2(p.gain)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {funds.length > 0 && (
          <div className="dash-sheet__section">
            <h4>TSP Funds That Year</h4>
            <ul className="credit-mini">
              {funds.map(([f, v]) => (
                <li key={f}>
                  <span>{f}</span>
                  <span className={tone(v)}>{pct(v)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </DetailSheet>
    );
  }
  const st = s.statements.find((x) => x.id === sheet.id);
  if (!st) return null;
  const file = data.files.find((f) => f.fileId === st.fileId);
  const ok = st.checks.filter((c) => c.ok).length;
  return (
    <DetailSheet title={`${fullDate(st.date)} · ${KIND_LABEL[st.kind]}`} sub={`${fullDate(st.start)} – ${fullDate(st.date)}`} onClose={onClose}>
      <ul className="credit-mini">
        <li>
          <span>Opening</span>
          <span>{money2(st.opening)}</span>
        </li>
        {st.contributions !== 0 && (
          <li>
            <span>Contributions</span>
            <span>{money2(st.contributions)}</span>
          </li>
        )}
        <li>
          <span>Gain / Loss</span>
          <span className={tone(st.gain)}>{money2(st.gain)}</span>
        </li>
        <li>
          <span>Closing</span>
          <span>
            <strong>{money2(st.closing)}</strong>
          </span>
        </li>
        {st.prr && (
          <li>
            <span>TSP personal return ({st.prr.window === '12mo' ? 'last 12 months' : 'this period'})</span>
            <span>{pct(st.prr.value, 2)}</span>
          </li>
        )}
      </ul>
      <div className="dash-sheet__section">
        <h4>
          Checks {ok}/{st.checks.length}
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

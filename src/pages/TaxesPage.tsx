import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { TaxesResponse, TaxInsight, TaxReturnRecord, TaxYearSummary } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';
import { FinanceLineChart } from '../components/FinanceLineChart';
import { DashTitle, InfoTip } from '../components/dash/InfoTip';
import { DetailSheet } from '../components/dash/DetailSheet';
import { SectionPicker } from '../components/dash/SectionPicker';
import { KebabMenu } from '../components/KebabMenu';
import { TaxYearEditor, blankTaxYear } from '../components/TaxYearEditor';
import { FEDERAL_GROUPS, ITEMIZED_FIELDS, STATE_FIELDS, STATUS_LABEL, STATUS_SHORT, balanceText, compact, driveUrl, money, pct } from '../utils/taxFields';

type Span = 'all' | '10y' | 'joint' | 'single';
const SPANS: [Span, string][] = [
  ['all', 'All Years'],
  ['10y', 'Last 10'],
  ['joint', 'Joint Years'],
  ['single', 'Single Years'],
];
type Metric = 'agi' | 'tax' | 'rate' | 'result' | 'bracket';
type Sheet = { kind: 'year'; year: number } | { kind: 'metric'; metric: Metric } | null;

const BLUE = '#2A6FB0';
const ORANGE = '#C0662E';
const yearX = (y: number) => Date.UTC(y, 6, 1);
const fmtYear = (ms: number) => String(new Date(ms).getUTCFullYear());

/** Finance → Taxes: every filed return since 2000 (Mike, 2026-10-12). Figures
 * were read once from the PDFs in the Drive "Taxes" folders; Mike edits a
 * year here. Trends and "Things to Check" are rule-based (worker/src/taxes). */
export function TaxesPage() {
  useReportTabMeta('Taxes', 'finance');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<TaxesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [editing, setEditing] = useState<{ rec: TaxReturnRecord; isNew: boolean } | null>(null);
  const [importing, setImporting] = useState(false);
  const [allInsights, setAllInsights] = useState(false);

  const load = useCallback(() => {
    api
      .getTaxes()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const span = (SPANS.some(([k]) => k === params.get('span')) ? params.get('span') : 'all') as Span;
  const setSpan = (s: Span) => {
    const next = new URLSearchParams(params);
    if (s === 'all') next.delete('span');
    else next.set('span', s);
    setParams(next, { replace: true });
  };

  const all = data?.summary ?? [];
  const lastYear = all.length ? all[all.length - 1].year : 0;
  const rows = useMemo(
    () => all.filter((y) => (span === '10y' ? y.year > lastYear - 10 : span === 'joint' ? y.status === 'mfj' : span === 'single' ? y.status === 'single' : true)),
    [all, span, lastYear],
  );
  const rec = (year: number) => data?.returns.find((r) => r.year === year) ?? null;

  const latest = rows[rows.length - 1] ?? null;
  const prev = rows.length > 1 ? rows[rows.length - 2] : null;
  const firstYear = all[0]?.year;
  const jointFrom = all.find((y) => y.status === 'mfj')?.year;

  const openYear = (year: number) => setSheet({ kind: 'year', year });

  return (
    <div className="finance-page taxes-page">
      <div className="breadcrumb">
        <button type="button" className="breadcrumb__back" onClick={() => navigate('/finance')} title="Back" aria-label="Back">
          ‹
        </button>
        <Link to="/finance" className="breadcrumb__link">
          Finance
        </Link>
        <span className="breadcrumb__sep">›</span>
        <span className="breadcrumb__current">Taxes</span>
      </div>

      <div className="links-page__header">
        <h1 className="heading-serif dash-title" style={{ fontSize: 24, margin: '0 0 2px' }}>
          Taxes
          <InfoTip label="About Taxes">
            <p>
              Every filed return, one row per tax year: federal 1040, New York, and Connecticut in the years Nell worked there. The figures were read once from the PDFs in the two “Taxes” folders in
              Google Drive and checked against each return’s own math.
            </p>
            <p>Edit a year from its row (⋯ → Edit). Each spring, add the new year with + Add Year. No Social Security or account numbers are stored — only the dollar lines.</p>
            <p>Rates here are income tax only: Social Security and Medicare payroll tax aren’t on the return.</p>
          </InfoTip>
        </h1>
        <KebabMenu
          items={[
            { label: '+ Add Year', onClick: () => setEditing({ rec: blankTaxYear(lastYear ? lastYear + 1 : new Date().getFullYear() - 1, all[all.length - 1]?.status ?? 'mfj'), isNew: true }) },
            { label: 'Import Years (JSON)…', onClick: () => setImporting(true) },
          ]}
        />
      </div>
      {data && all.length > 0 && (
        <p className="links-page__subhead">
          {all.length} returns · {firstYear}–{lastYear}
          {jointFrom ? ` · Single until ${jointFrom - 1}, filing jointly since ${jointFrom}` : ''}
        </p>
      )}

      {error && <div className="empty-state">Couldn’t load taxes: {error}</div>}
      {!data && !error && <div className="empty-state empty-state--section">Loading…</div>}
      {data && all.length === 0 && <div className="empty-state">No tax years yet. Use ⋯ → + Add Year, or import them.</div>}

      {data && all.length > 0 && latest && (
        <>
          <SectionPicker options={SPANS} value={span} onChange={setSpan} label="Years" className="taxes-page__span" />

          <div className="fin-dash__stats fin-dash__stats--5">
            <Tile label={`AGI · ${latest.year}`} value={compact(latest.agi)} sub={change(latest.agi, prev?.agi, prev?.year)} onClick={() => setSheet({ kind: 'metric', metric: 'agi' })} />
            <Tile
              label="Income Tax"
              value={compact(latest.totalTax ?? latest.federalTax)}
              sub={latest.totalTax !== null ? `Federal ${compact(latest.federalTax)} · State ${compact(latest.stateTax)}` : 'Federal only — state not in'}
              onClick={() => setSheet({ kind: 'metric', metric: 'tax' })}
            />
            <Tile
              label="Effective Rate"
              value={pct(latest.effTotal ?? latest.effFederal)}
              sub={latest.effTotal !== null ? `Federal ${pct(latest.effFederal)}` : 'Federal only'}
              onClick={() => setSheet({ kind: 'metric', metric: 'rate' })}
            />
            <Tile
              label="Federal Result"
              value={balanceText(latest.federalBalance)}
              sub={latest.stateBalance !== null ? `State ${latest.stateBalance >= 0 ? 'refund' : 'owed'} ${money(Math.abs(latest.stateBalance))}` : '—'}
              tone={latest.federalBalance !== null && latest.federalBalance < 0 ? 'down' : ''}
              onClick={() => setSheet({ kind: 'metric', metric: 'result' })}
            />
            <Tile
              label="Top Bracket"
              value={latest.marginal ? `${latest.marginal.rate}%` : '—'}
              sub={latest.marginal?.roomToNext != null && latest.marginal.nextRate ? `${compact(latest.marginal.roomToNext)} below ${latest.marginal.nextRate}%` : 'federal, ordinary income'}
              onClick={() => setSheet({ kind: 'metric', metric: 'bracket' })}
            />
          </div>

          <div className="fin-dash__grid">
            {data.insights.length > 0 && (
              <section className="fin-dash__card fin-dash__card--full">
                <DashTitle info={<p>Rule-based checks on your own returns — patterns worth a look, not tax advice. Talk them over with your preparer before acting.</p>}>Things to Check</DashTitle>
                <ul className="taxes-insights">
                  {(allInsights ? data.insights : data.insights.slice(0, 4)).map((i) => (
                    <Insight key={i.key} i={i} onYear={openYear} />
                  ))}
                </ul>
                {data.insights.length > 4 && (
                  <button type="button" className="btn btn--ghost btn--sm taxes-insights__more" onClick={() => setAllInsights((v) => !v)}>
                    {allInsights ? 'Show Fewer' : `Show ${data.insights.length - 4} More`}
                  </button>
                )}
              </section>
            )}

            <section className="fin-dash__card fin-dash__card--wide">
              <DashTitle
                info={
                  <p>
                    Adjusted Gross Income as filed, and the same amount in {data.cpiBaseYear} dollars (CPI-U) so years compare fairly. Single until {jointFrom ? jointFrom - 1 : '—'}; joint (two
                    incomes) after.
                  </p>
                }
              >
                Income Over Time
              </DashTitle>
              <FinanceLineChart
                ariaLabel="AGI by year"
                formatX={fmtYear}
                formatY={(v) => compact(v)}
                series={[
                  { name: 'AGI', color: BLUE, points: rows.filter((y) => y.agi !== null).map((y) => ({ x: yearX(y.year), y: y.agi! })) },
                  { name: `In ${data.cpiBaseYear} Dollars`, color: ORANGE, points: rows.filter((y) => y.agiReal !== null).map((y) => ({ x: yearX(y.year), y: y.agiReal! })) },
                ]}
              />
            </section>

            <section className="fin-dash__card fin-dash__card--wide">
              <DashTitle
                info={
                  <p>
                    Income tax ÷ AGI. Federal is the 1040’s total tax (incl. Additional Medicare and NIIT); with state adds New York and Connecticut after New York’s credit for tax paid to
                    Connecticut.
                  </p>
                }
              >
                Effective Tax Rate
              </DashTitle>
              <FinanceLineChart
                ariaLabel="Effective tax rate by year"
                formatX={fmtYear}
                formatY={(v) => `${v.toFixed(0)}%`}
                series={[
                  { name: 'Federal', color: BLUE, points: rows.filter((y) => y.effFederal !== null).map((y) => ({ x: yearX(y.year), y: y.effFederal! * 100 })) },
                  { name: 'Federal + State', color: ORANGE, points: rows.filter((y) => y.effTotal !== null).map((y) => ({ x: yearX(y.year), y: y.effTotal! * 100 })) },
                ]}
              />
            </section>

            <section className="fin-dash__card">
              <DashTitle info={<p>Federal refund (+) or amount owed (−) at filing, penalties included. Tap a year for the detail.</p>}>Refund or Owed</DashTitle>
              <Bars
                rows={[...rows].reverse().map((y) => ({ key: y.year, label: String(y.year), value: y.federalBalance ?? 0, sub: y.penalty ? 'Penalty' : '' }))}
                onClick={openYear}
                signed
              />
            </section>

            <section className="fin-dash__card">
              <DashTitle info={<p>Wages per person from the W-2s, investments = interest + dividends + capital gain/loss, other = everything else on the 1040 (unemployment, 1099 income…).</p>}>
                Where {latest.year}’s Income Came From
              </DashTitle>
              <IncomeMix y={latest} />
              {prev && (
                <p className="fin-dash__stat-sub">
                  {prev.year}: AGI {compact(prev.agi)} ·{' '}
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => openYear(prev.year)}>
                    Open {prev.year}
                  </button>
                </p>
              )}
            </section>

            <section className="fin-dash__card">
              <DashTitle info={<p>The deduction taken each year. Itemized years show the state & local tax the cap disallowed (the cap was $10,000 for 2018–2024, $40,000 from 2025).</p>}>
                Deductions
              </DashTitle>
              <Bars
                rows={[...rows]
                  .reverse()
                  .filter((y) => y.deduction !== null)
                  .map((y) => ({
                    key: y.year,
                    label: String(y.year),
                    value: y.deduction ?? 0,
                    sub: y.deductionType === 'itemized' ? 'Itemized' : 'Standard',
                  }))}
                onClick={openYear}
              />
            </section>

            <section className="fin-dash__card fin-dash__card--full">
              <DashTitle info={<p>Tap a year for every line on the return, the W-2s behind it, notes, and links to the PDFs in Drive. ⚠ marks a year with figures to double-check.</p>}>
                Every Year
              </DashTitle>
              <div className="fin-dash__table-wrap post-table">
                <table className="fin-dash__table taxes-table">
                  <thead>
                    <tr>
                      <th>Year</th>
                      <th>Status</th>
                      <th className="num">AGI</th>
                      <th className="num">Taxable</th>
                      <th className="num">Federal</th>
                      <th className="num">State</th>
                      <th className="num">Rate</th>
                      <th className="num">Result</th>
                      <th>Prepared By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...rows].reverse().map((y) => (
                      <tr key={y.year} className="bee-social__row" onClick={() => openYear(y.year)}>
                        <td>
                          {y.year}
                          {y.amended && <span className="taxes-chip">Amended</span>}
                          {(y.doubtCount > 0 || !y.complete) && (
                            <span className="taxes-warn" title={!y.complete ? 'Only the totals are in' : 'Figures to double-check'}>
                              {' '}
                              ⚠
                            </span>
                          )}
                        </td>
                        <td>{STATUS_SHORT[y.status]}</td>
                        <td className="num">{money(y.agi)}</td>
                        <td className="num">{money(y.taxableIncome)}</td>
                        <td className="num">{money(y.federalTax)}</td>
                        <td className="num">{money(y.stateTax)}</td>
                        <td className="num">{pct(y.effTotal ?? y.effFederal)}</td>
                        <td className={`num${(y.federalBalance ?? 0) < 0 ? ' fin-dash__neg' : ''}`}>{money(y.federalBalance, true)}</td>
                        <td className="taxes-table__prep">{y.preparedBy ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="post-cards">
                {[...rows].reverse().map((y) => (
                  <li key={y.year}>
                    <button type="button" className="post-card" onClick={() => openYear(y.year)}>
                      <span className="post-card__top">
                        {y.year} · {STATUS_SHORT[y.status]}
                        {y.amended ? ' · Amended' : ''}
                        {y.doubtCount > 0 || !y.complete ? ' · ⚠' : ''}
                      </span>
                      <span className="post-card__title paypal-dash__card-title">
                        <span>AGI {money(y.agi)}</span>
                        <span>{pct(y.effTotal ?? y.effFederal)}</span>
                      </span>
                      <span className={`paypal-dash__sub${(y.federalBalance ?? 0) < 0 ? ' fin-dash__neg' : ''}`}>
                        Tax {money(y.totalTax ?? y.federalTax)} · {balanceText(y.federalBalance)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </>
      )}

      {sheet?.kind === 'year' && rec(sheet.year) && (
        <YearSheet
          r={rec(sheet.year)!}
          s={all.find((y) => y.year === sheet.year)!}
          onClose={() => setSheet(null)}
          onEdit={() => {
            setEditing({ rec: rec(sheet.year)!, isNew: false });
            setSheet(null);
          }}
        />
      )}
      {sheet?.kind === 'metric' && <MetricSheet metric={sheet.metric} rows={rows} cpiYear={data?.cpiBaseYear ?? 0} onYear={openYear} onClose={() => setSheet(null)} />}
      {editing && (
        <TaxYearEditor
          initial={editing.rec}
          isNew={editing.isNew}
          takenYears={all.map((y) => y.year)}
          onClose={() => setEditing(null)}
          onSaved={(r) => {
            setEditing(null);
            load();
            setSheet({ kind: 'year', year: r.year });
          }}
          onDeleted={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {importing && (
        <ImportSheet
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

function change(cur: number | null | undefined, before: number | null | undefined, beforeYear?: number) {
  if (cur == null || before == null || !before || !beforeYear) return '';
  const d = cur / before - 1;
  return `${d >= 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(0)}% vs ${beforeYear}`;
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

function Bars({ rows, onClick, signed }: { rows: { key: number; label: string; value: number; sub?: string }[]; onClick: (key: number) => void; signed?: boolean }) {
  if (!rows.length) return <p className="fin-dash__muted">Nothing in these years.</p>;
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <div className="fin-dash__years taxes-bars">
      {rows.map((r) => (
        <button key={r.key} type="button" className="fin-dash__year paypal-dash__row" onClick={() => onClick(r.key)}>
          <span className="fin-dash__year-label">{r.label}</span>
          <span className="fin-dash__year-track">
            <span className={`fin-dash__year-bar${r.value < 0 ? ' taxes-bar--neg' : ''}`} style={{ width: `${(Math.abs(r.value) / max) * 100}%` }} />
          </span>
          <span className={`fin-dash__year-value${r.value < 0 ? ' fin-dash__neg' : ''}`}>{signed ? money(r.value, true) : compact(r.value)}</span>
          <span className="fin-dash__year-bills">{r.sub ?? ''}</span>
        </button>
      ))}
    </div>
  );
}

function IncomeMix({ y }: { y: TaxYearSummary }) {
  if (!y.complete) return <p className="fin-dash__muted">{y.year} only has the e-file totals — open the year to add the income lines.</p>;
  const parts: { label: string; value: number }[] = [];
  const people = Object.entries(y.wagesByWho);
  const peopleTotal = people.reduce((s, [, v]) => s + v, 0);
  if (people.length) for (const [who, v] of people) parts.push({ label: `${who}’s Wages`, value: v });
  // W-2 boxes and the 1040 line can differ by a few dollars; keep the 1040.
  if (!people.length || Math.abs(peopleTotal - (y.wages ?? 0)) > 50) {
    parts.length = 0;
    parts.push({ label: 'Wages', value: y.wages ?? 0 });
  }
  if (y.investmentIncome) parts.push({ label: 'Investments', value: y.investmentIncome });
  if (y.otherIncome) parts.push({ label: 'Other', value: y.otherIncome });
  const max = Math.max(1, ...parts.map((p) => Math.abs(p.value)));
  return (
    <div className="fin-dash__years taxes-mix">
      {parts.map((p) => (
        <div key={p.label} className="fin-dash__year">
          <span className="fin-dash__year-label">{p.label}</span>
          <span className="fin-dash__year-track">
            <span className={`fin-dash__year-bar${p.value < 0 ? ' taxes-bar--neg' : ''}`} style={{ width: `${(Math.abs(p.value) / max) * 100}%` }} />
          </span>
          <span className={`fin-dash__year-value${p.value < 0 ? ' fin-dash__neg' : ''}`}>{compact(p.value)}</span>
          <span className="fin-dash__year-bills" />
        </div>
      ))}
    </div>
  );
}

function Insight({ i, onYear }: { i: TaxInsight; onYear: (y: number) => void }) {
  return (
    <li className={`taxes-insight taxes-insight--${i.tone}`}>
      <span className="taxes-insight__icon" aria-hidden="true">
        {i.tone === 'warn' ? '⚠' : i.tone === 'good' ? '✓' : 'ℹ'}
      </span>
      <span className="taxes-insight__body">
        <span className="taxes-insight__title">{i.title}</span>
        <span className="taxes-insight__detail">{i.detail}</span>
        {i.years.length > 0 && i.years.length <= 8 && (
          <span className="taxes-insight__years">
            {i.years.map((y) => (
              <button key={y} type="button" className="btn btn--ghost btn--sm" onClick={() => onYear(y)}>
                {y}
              </button>
            ))}
          </span>
        )}
      </span>
    </li>
  );
}

const METRIC_TITLE: Record<Metric, string> = { agi: 'Adjusted Gross Income', tax: 'Income Tax Paid', rate: 'Effective Tax Rate', result: 'Refund or Owed', bracket: 'Top Federal Bracket' };

function MetricSheet({ metric, rows, cpiYear, onYear, onClose }: { metric: Metric; rows: TaxYearSummary[]; cpiYear: number; onYear: (y: number) => void; onClose: () => void }) {
  const pts = (f: (y: TaxYearSummary) => number | null | undefined) => rows.filter((y) => f(y) != null).map((y) => ({ x: yearX(y.year), y: f(y)! }));
  const series =
    metric === 'agi'
      ? [
          { name: 'AGI', color: BLUE, points: pts((y) => y.agi) },
          { name: `In ${cpiYear} Dollars`, color: ORANGE, points: pts((y) => y.agiReal) },
        ]
      : metric === 'tax'
        ? [
            { name: 'Federal', color: BLUE, points: pts((y) => y.federalTax) },
            { name: 'State', color: ORANGE, points: pts((y) => y.stateTax) },
          ]
        : metric === 'rate'
          ? [
              { name: 'Federal', color: BLUE, points: pts((y) => (y.effFederal != null ? y.effFederal * 100 : null)) },
              { name: 'Federal + State', color: ORANGE, points: pts((y) => (y.effTotal != null ? y.effTotal * 100 : null)) },
            ]
          : metric === 'result'
            ? [
                { name: 'Federal', color: BLUE, points: pts((y) => y.federalBalance) },
                { name: 'State', color: ORANGE, points: pts((y) => y.stateBalance) },
              ]
            : [{ name: 'Top Rate', color: BLUE, points: pts((y) => y.marginal?.rate), step: true }];
  const fmtY = metric === 'rate' || metric === 'bracket' ? (v: number) => `${v.toFixed(0)}%` : (v: number) => compact(v);
  const cell = (y: TaxYearSummary) =>
    metric === 'agi'
      ? [money(y.agi), money(y.agiReal)]
      : metric === 'tax'
        ? [money(y.federalTax), money(y.stateTax), money(y.totalTax)]
        : metric === 'rate'
          ? [pct(y.effFederal), pct(y.effTotal)]
          : metric === 'result'
            ? [money(y.federalBalance, true), money(y.stateBalance, true), y.penalty ? money(y.penalty) : '—']
            : [y.marginal ? `${y.marginal.rate}%` : '—', money(y.taxableIncome), y.marginal?.roomToNext != null ? money(y.marginal.roomToNext) : '—'];
  const heads =
    metric === 'agi'
      ? ['AGI', `${cpiYear} $`]
      : metric === 'tax'
        ? ['Federal', 'State', 'Total']
        : metric === 'rate'
          ? ['Federal', '+ State']
          : metric === 'result'
            ? ['Federal', 'State', 'Penalty']
            : ['Rate', 'Taxable', 'To Next'];
  return (
    <DetailSheet title={METRIC_TITLE[metric]} sub={rows.length ? `${rows[0].year}–${rows[rows.length - 1].year}` : ''} onClose={onClose}>
      <FinanceLineChart ariaLabel={METRIC_TITLE[metric]} formatX={fmtYear} formatY={fmtY} series={series} />
      {metric === 'bracket' && <p className="fin-dash__stat-sub">The rate on the last dollar of ordinary income. Shown for 2011 on; brackets before that aren’t loaded.</p>}
      <div className="fin-dash__table-wrap">
        <table className="fin-dash__table">
          <thead>
            <tr>
              <th>Year</th>
              {heads.map((h) => (
                <th key={h} className="num">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...rows].reverse().map((y) => (
              <tr key={y.year} className="bee-social__row" onClick={() => onYear(y.year)}>
                <td>{y.year}</td>
                {cell(y).map((c, i) => (
                  <td key={i} className="num">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DetailSheet>
  );
}

function YearSheet({ r, s, onClose, onEdit }: { r: TaxReturnRecord; s: TaxYearSummary; onClose: () => void; onEdit: () => void }) {
  const f = r.federal;
  const line = (label: string, v: number | null | undefined, strong = false) =>
    v === null || v === undefined || (v === 0 && !strong) ? null : (
      <div key={label} className={`taxes-line${strong ? ' taxes-line--strong' : ''}`}>
        <span>{label}</span>
        <span className={v < 0 ? 'fin-dash__neg' : undefined}>{money(v)}</span>
      </div>
    );
  const STRONG = new Set(['agi', 'taxable_income', 'total_tax', 'refund', 'amount_owed', 'total']);
  return (
    <DetailSheet
      title={`${r.year} Tax Return`}
      sub={[STATUS_LABEL[r.filing_status], r.prepared_by, r.amended ? 'Amended' : null, r.dependents ? `${r.dependents} dependent${r.dependents > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ')}
      onClose={onClose}
    >
      <div className="taxes-year__chips">
        <span className="taxes-year__chip">AGI {money(s.agi)}</span>
        <span className="taxes-year__chip">Rate {pct(s.effTotal ?? s.effFederal)}</span>
        {s.marginal && <span className="taxes-year__chip">Top bracket {s.marginal.rate}%</span>}
        <span className={`taxes-year__chip${(s.federalBalance ?? 0) < 0 ? ' fin-dash__neg' : ''}`}>{balanceText(s.federalBalance)}</span>
        <button type="button" className="btn btn--sm" onClick={onEdit}>
          Edit
        </button>
      </div>

      {(!s.complete || r.doubts.length > 0) && (
        <div className="taxes-year__doubts">
          <strong>⚠ Double-check</strong>
          {!s.complete && <p>Only the e-file totals are in — the income and deduction lines are missing.</p>}
          <ul>
            {r.doubts.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="taxes-year__grid">
        {FEDERAL_GROUPS.map((g) => {
          const items = g.fields.map(([k, label]) => line(label, f[k] as number | null, STRONG.has(k))).filter(Boolean);
          if (!items.length) return null;
          return (
            <div key={g.title} className="taxes-year__block">
              <h4>
                Federal · {g.title}
                {g.title === 'Deductions' && f.deduction_type ? ` (${f.deduction_type === 'itemized' ? 'Itemized' : 'Standard'})` : ''}
              </h4>
              {items}
              {g.title === 'Tax' && f.credit_detail && <p className="taxes-year__detail">Credits: {f.credit_detail}</p>}
              {g.title === 'Tax' && f.other_taxes_detail && <p className="taxes-year__detail">Other taxes: {f.other_taxes_detail}</p>}
              {g.title === 'Deductions' && s.standardDeduction && f.deduction_type === 'itemized' && <p className="taxes-year__detail">Standard deduction that year: {money(s.standardDeduction)}</p>}
            </div>
          );
        })}
        {r.itemized && (
          <div className="taxes-year__block">
            <h4>Itemized (Schedule A)</h4>
            {ITEMIZED_FIELDS.map(([k, label]) => line(label, r.itemized![k], STRONG.has(k)))}
          </div>
        )}
        {(['ny', 'ct'] as const).map((st) =>
          r[st] ? (
            <div key={st} className="taxes-year__block">
              <h4>{st === 'ny' ? 'New York' : `Connecticut${r.ct?.filer ? ` · ${r.ct.filer}` : ''}`}</h4>
              {STATE_FIELDS.map(([k, label]) => line(label, r[st]![k] as number | null, k === 'total_tax'))}
              {r[st]!.notes && <p className="taxes-year__detail">{r[st]!.notes}</p>}
            </div>
          ) : null,
        )}
        {r.people.length > 0 && (
          <div className="taxes-year__block">
            <h4>W-2s</h4>
            {r.people.map((p, i) => (
              <div key={i} className="taxes-line">
                <span>
                  {p.who} · {p.employer}
                </span>
                <span>{money(p.wages)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {r.notes.length > 0 && (
        <div className="taxes-year__block">
          <h4>Notes</h4>
          <ul className="taxes-year__notes">
            {r.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      {r.source_files.length > 0 && (
        <div className="taxes-year__block">
          <h4>Files in Drive</h4>
          <ul className="taxes-year__files">
            {r.source_files.map((x) => (
              <li key={x.id}>
                <a href={driveUrl(x.id)} target="_blank" rel="noreferrer">
                  {x.title}
                </a>{' '}
                <span className="fin-dash__muted">{x.what}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </DetailSheet>
  );
}

function ImportSheet({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : parsed.returns;
      const res = await api.importTaxYears(list);
      setMsg(`Imported ${res.imported}: ${res.years.join(', ')}`);
      setTimeout(onDone, 800);
    } catch (e) {
      setMsg(String(e));
      setBusy(false);
    }
  }
  return (
    <DetailSheet title="Import Tax Years" sub="Paste a JSON array of years (same shape as an exported year). Existing years are replaced." onClose={onClose}>
      <textarea className="taxes-import" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder='[{"year": 2026, "filing_status": "mfj", "federal": {...}}]' />
      <div className="modal__actions">
        {msg && <span className="fin-dash__stat-sub">{msg}</span>}
        <button type="button" className="btn" disabled={busy || !text.trim()} onClick={run}>
          Import
        </button>
      </div>
    </DetailSheet>
  );
}

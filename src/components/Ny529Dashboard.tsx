import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Ny529Dashboard as Data, Ny529MonthState } from '../api/types';
import { FinanceLineChart } from './FinanceLineChart';
import type { LineSeries } from './FinanceLineChart';

// Validated pair (dataviz validator: CVD ΔE 20, normal-vision ΔE 26 on the paper surface).
const VALUE_COLOR = '#2A6FB0';
const CONTRIB_COLOR = '#C0662E';

const money = (n: number, cents = true) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
const moneyAxis = (n: number) => (Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}K` : `$${Math.round(n)}`);
const pct = (n: number | null) => (n === null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`);
const toMs = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
const fmtDate = (iso: string) => new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtShort = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
const fmtDay = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const quarterLabel = (end: string) => `Q${Math.ceil(Number(end.slice(5, 7)) / 3)} ${end.slice(0, 4)}`;
const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

const MONTH_STATE: Record<Ny529MonthState, { icon: string; label: string }> = {
  deposited: { icon: '✓', label: 'Deposited' },
  missed: { icon: '✕', label: 'Missed' },
  upcoming: { icon: '○', label: 'Upcoming' },
  before_start: { icon: '–', label: 'Before AIP Started' },
  unknown: { icon: '…', label: 'Awaiting Statement' },
};

export function Ny529Dashboard({ data, onDismissFlag }: { data: Data; onDismissFlag: (id: string) => void }) {
  const { summary: s, transactions, statements, files } = data;
  const [showTxns, setShowTxns] = useState(false);
  const fileUrl = (fileId: string) => files.find((f) => f.fileId === fileId)?.url ?? null;

  // Value vs contributed over time. With a single portfolio, units held ×
  // the price on each deposit date gives the market value between
  // statements; statement endings anchor it.
  const valueSeries = useMemo<LineSeries[]>(() => {
    const value: { x: number; y: number }[] = [];
    const contributed: { x: number; y: number }[] = [];
    const first = statements[0];
    if (!first) return [];
    value.push({ x: toMs(first.periodStart), y: s.quarters[0]?.beginning ?? 0 });
    contributed.push({ x: toMs(first.periodStart), y: 0 });
    const single = s.quarters.length > 0;
    let units = 0;
    let contrib = 0;
    const events = [
      ...transactions.map((t) => ({ date: t.date, t })),
      ...s.quarters.map((q) => ({ date: q.periodEnd, q })),
    ].sort((a, b) => a.date.localeCompare(b.date) || ('q' in a ? 1 : -1));
    for (const e of events) {
      if ('t' in e && e.t) {
        units += e.t.units ?? 0;
        contrib += e.t.kind === 'withdrawal' ? 0 : e.t.amount;
        contributed.push({ x: toMs(e.date), y: Math.round(contrib * 100) / 100 });
        if (single && e.t.unitPrice) value.push({ x: toMs(e.date), y: Math.round(units * e.t.unitPrice * 100) / 100 });
      } else if ('q' in e && e.q) {
        value.push({ x: toMs(e.date), y: e.q.ending });
      }
    }
    return [
      { name: 'Value', color: VALUE_COLOR, points: value },
      { name: 'Contributed', color: CONTRIB_COLOR, points: contributed, step: true },
    ];
  }, [statements, transactions, s.quarters]);

  const priceSeries = useMemo<LineSeries[]>(() => {
    const pts = [
      ...transactions.filter((t) => t.unitPrice).map((t) => ({ x: toMs(t.date), y: t.unitPrice! })),
      ...s.quarters.filter((q) => q.unitPrice).map((q) => ({ x: toMs(q.periodEnd), y: q.unitPrice! })),
    ].sort((a, b) => a.x - b.x);
    return [{ name: 'Unit Price', color: VALUE_COLOR, points: pts }];
  }, [transactions, s.quarters]);

  const ytdPct = Math.min(100, (s.ytdContributions / s.limit) * 100);
  const projPct = Math.min(100, (s.projectedYearEnd / s.limit) * 100);
  const checksTotal = statements.reduce((n, st) => n + st.checks.length, 0);
  const checksOk = statements.reduce((n, st) => n + st.checks.filter((c) => c.ok).length, 0);

  return (
    <div className="ny529">
      {data.flags.length > 0 && (
        <div className="ny529__flags">
          {data.flags.map((f) => (
            <div key={f.id} className={`ny529__flag ny529__flag--${f.severity}`}>
              <span className="ny529__flag-icon">{f.severity === 'warn' ? '⚠' : 'ℹ'}</span>
              <span className="ny529__flag-msg">{f.message}</span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => onDismissFlag(f.id)}>
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="ny529__stats">
        <Stat label="Value" value={money(s.value)} sub={s.asOf ? `As of ${fmtDate(s.asOf)}` : undefined} />
        <Stat label="Contributed" value={money(s.principal)} sub={s.aip ? `Since ${fmtDate(s.aip.startedOn)}` : undefined} />
        <Stat label="Earnings" value={money(s.earnings)} sub={s.gainPct !== null ? `${pct(s.gainPct)} on contributions` : undefined} tone={s.earnings >= 0 ? 'good' : 'bad'} />
        <Stat label="Monthly Deposit" value={s.aip ? money(s.aip.amount) : '—'} sub={s.aip ? `Around the ${ordinal(s.aip.day)} (AIP)` : 'No automatic deposit found'} />
      </div>

      <div className="ny529__grid">
        <section className="ny529__card ny529__card--wide">
          <h3 className="ny529__card-title">Value vs. Contributed</h3>
          <FinanceLineChart series={valueSeries} formatY={moneyAxis} formatX={fmtShort} ariaLabel="529 value and contributions over time" />
          <p className="ny529__note">Between statements, value is estimated from units held × the price on each deposit date.</p>
        </section>

        <section className="ny529__card">
          <h3 className="ny529__card-title">{s.year} NY Deduction</h3>
          <div className="ny529__meter" role="img" aria-label={`${money(s.ytdContributions)} contributed of ${money(s.limit, false)}; ${money(s.projectedYearEnd)} projected by Dec 31`}>
            <div className="ny529__meter-proj" style={{ width: `${projPct}%` }} />
            <div className="ny529__meter-fill" style={{ width: `${ytdPct}%` }} />
          </div>
          <div className="ny529__meter-legend">
            <span>
              <span className="ny529__key ny529__key--fill" /> On Statements {money(s.ytdContributions)}
              {s.ytdAsOf && <span className="ny529__muted"> (through {fmtDate(s.ytdAsOf)})</span>}
            </span>
            <span>
              <span className="ny529__key ny529__key--proj" /> Projected by Dec 31 {money(s.projectedYearEnd)}
              <span className="ny529__muted"> (+{s.remainingDrafts} deposits)</span>
            </span>
            <span>Limit {money(s.limit, false)}</span>
          </div>
          {s.gap >= 1 ? (
            <div className="ny529__gap">
              <strong>{money(s.gap)} short</strong> of the full deduction.{' '}
              {data.topupTask && data.topupTask.status !== 'done' ? `Reminder set for ${data.topupTask.due ? fmtDate(data.topupTask.due) : 'Dec 1'}.` : 'Top up by Dec 31.'}
            </div>
          ) : (
            <div className="ny529__gap ny529__gap--ok">✓ On pace for the full {money(s.limit, false)} deduction.</div>
          )}

          <h4 className="ny529__subtitle">Deposit Health · {s.year}</h4>
          <div className="ny529__months">
            {s.months.map((m) => {
              const st = MONTH_STATE[m.state];
              const label = new Date(toMs(`${m.month}-01`)).toLocaleDateString('en-US', { month: 'short' });
              return (
                <div key={m.month} className={`ny529__month ny529__month--${m.state}`} title={`${label}: ${st.label}${m.amount ? ` · ${money(m.amount)}` : ''}`}>
                  <span className="ny529__month-icon" aria-hidden="true">
                    {st.icon}
                  </span>
                  <span className="ny529__month-label">{label}</span>
                </div>
              );
            })}
          </div>
          <div className="ny529__months-key">
            {(['deposited', 'missed', 'unknown', 'upcoming'] as Ny529MonthState[]).map((k) => (
              <span key={k}>
                {MONTH_STATE[k].icon} {MONTH_STATE[k].label}
              </span>
            ))}
          </div>
        </section>

        <section className="ny529__card ny529__card--wide">
          <h3 className="ny529__card-title">By Quarter</h3>
          <div className="ny529__table-wrap">
            <table className="ny529__table">
              <thead>
                <tr>
                  <th>Quarter</th>
                  <th>Contributions</th>
                  <th>Earnings</th>
                  <th>Return</th>
                  <th>Ending Value</th>
                  <th>Unit Price</th>
                  <th>Math</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {[...s.quarters].reverse().map((q) => {
                  const st = statements.find((x) => x.periodEnd === q.periodEnd);
                  const failed = st?.checks.filter((c) => !c.ok) ?? [];
                  const url = fileUrl(q.fileId);
                  return (
                    <tr key={q.periodEnd}>
                      <td>{quarterLabel(q.periodEnd)}</td>
                      <td>{money(q.contributions)}</td>
                      <td className={q.earnings < 0 ? 'ny529__neg' : undefined}>{money(q.earnings)}</td>
                      <td className={q.returnPct !== null && q.returnPct < 0 ? 'ny529__neg' : undefined}>{pct(q.returnPct)}</td>
                      <td>{money(q.ending)}</td>
                      <td>{q.unitPrice !== null ? money(q.unitPrice) : '—'}</td>
                      <td title={st?.checks.map((c) => `${c.ok ? '✓' : '✕'} ${c.name}: ${c.detail}`).join('\n')}>
                        {failed.length ? `✕ ${failed.length} failed` : `✓ ${st?.checks.length ?? 0}/${st?.checks.length ?? 0}`}
                      </td>
                      <td>
                        {url && (
                          <a href={url} target="_blank" rel="noreferrer">
                            Statement ↗
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="ny529__note">Return is the change in unit price over the quarter (time-weighted, so deposits don’t inflate it). First quarter has no starting price.</p>
        </section>

        <section className="ny529__card">
          <h3 className="ny529__card-title">Unit Price · {s.portfolio ?? 'Portfolio'}</h3>
          <FinanceLineChart series={priceSeries} height={170} yFromZero={false} formatY={(v) => `$${v.toFixed(2)}`} formatX={fmtDay} ariaLabel="Unit price over time" />
        </section>

        {s.projection && (
          <section className="ny529__card">
            <h3 className="ny529__card-title">Hypothetical at Enrollment</h3>
            <div className="ny529__proj-value">{money(s.projection.value, false)}</div>
            <div className="ny529__muted">
              by {new Date(toMs(s.projection.targetDate)).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} · {money(s.projection.contributed, false)}{' '}
              contributed
            </div>
            <p className="ny529__note">
              Illustration only — assumes the {s.aip ? money(s.aip.amount) : ''} monthly deposit continues and a steady {s.projection.returnPct}%/yr return, compounded monthly. Not a
              forecast. Change the rate in <Link to="/settings?cat=statements">Settings → Statements</Link>.
            </p>
          </section>
        )}

        <section className="ny529__card ny529__card--full">
          <div className="ny529__card-head">
            <h3 className="ny529__card-title">Transactions</h3>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowTxns((v) => !v)}>
              {showTxns ? 'Hide' : `Show ${transactions.length}`}
            </button>
          </div>
          {showTxns && (
            <div className="ny529__table-wrap">
              <table className="ny529__table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description</th>
                    <th>Units</th>
                    <th>Unit Price</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {[...transactions].reverse().map((t, i) => (
                    <tr key={`${t.date}-${i}`}>
                      <td>{fmtDate(t.date)}</td>
                      <td>{t.description}</td>
                      <td>{t.units?.toFixed(4) ?? '—'}</td>
                      <td>{t.unitPrice !== null ? money(t.unitPrice) : '—'}</td>
                      <td className={t.amount < 0 ? 'ny529__neg' : undefined}>{money(t.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="ny529__note">
            {statements.length} statement{statements.length === 1 ? '' : 's'} read · {checksOk}/{checksTotal} math checks passed
            {files.some((f) => f.status !== 'parsed') && ` · ${files.filter((f) => f.status !== 'parsed').length} file(s) not read`}
            {data.folder.folderUrl && (
              <>
                {' · '}
                <a href={data.folder.folderUrl} target="_blank" rel="noreferrer">
                  Drive Folder ↗
                </a>
              </>
            )}
            {data.folder.vaultEntryId && (
              <>
                {' · '}
                <Link to={`/vault/${data.folder.vaultEntryId}`}>Vault Note</Link>
              </>
            )}
            {data.template?.site && (
              <>
                {' · '}
                <a href={data.template.site} target="_blank" rel="noreferrer">
                  nysaves.org ↗
                </a>
              </>
            )}
          </p>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="ny529__stat">
      <span className="ny529__stat-label">{label}</span>
      <span className={`ny529__stat-value${tone === 'bad' ? ' ny529__neg' : ''}`}>{value}</span>
      {sub && <span className="ny529__stat-sub">{sub}</span>}
    </div>
  );
}

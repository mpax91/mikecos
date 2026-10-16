import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { HanoverDashboard as Data, HanoverLine, HanoverPolicy } from '../api/types';
import { FinanceLineChart } from './FinanceLineChart';
import type { LineSeries } from './FinanceLineChart';
import { DashTitle, InfoTip } from './dash/InfoTip';
import { DetailSheet } from './dash/DetailSheet';
import { nyToday } from '../utils/dateRange';

// Validated categorical trio (dataviz validator, light + dark: CVD ΔE ≥ 17.9, normal ≥ 23.4).
const LINE_COLOR: Record<HanoverLine, string> = { auto: '#2A6FB0', home: '#C0662E', umbrella: '#7A5BB5' };

const money = (n: number, cents = true) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
const toMs = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
const fmtDate = (iso: string) => new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtShortDate = (iso: string) => new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmtShort = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
const addDays = (iso: string, n: number) => {
  const d = new Date(toMs(iso));
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const usd0 = (n: number | null | undefined) => (n == null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`);
const termLabel = (start: string, end: string) => `${start.slice(0, 4)}–${end.slice(2, 4)}`;
const paidByText = (p: HanoverPolicy, last4: string | null) => (p.paidVia === 'escrow' ? 'Mortgage escrow' : p.paidVia === 'autopay' ? `Auto-Pay${last4 ? ` ••${last4}` : ''}` : 'Bill');

function keyLimits(p: HanoverPolicy): string {
  const c = p.current;
  if (p.line === 'auto') return [`${usd0(c.liabilityCsl)} liability`, `${usd0(c.collisionDeductible)} collision / ${usd0(c.comprehensiveDeductible)} comp`].join(' · ');
  if (p.line === 'home') return [`${usd0(c.dwelling)} dwelling`, `${usd0(c.personalLiability)} liability`, `${usd0(c.deductible)} deductible`].join(' · ');
  return [`${usd0(c.limit)} limit`, `${usd0(c.excessUm)} excess UM/UIM`].join(' · ');
}

type Sheet = { kind: 'payments'; title: string; filter: 'all' | 'withdrawn' | 'scheduled' } | { kind: 'premiums' } | { kind: 'policy'; policy: HanoverPolicy } | { kind: 'renewal' };

/** Hanover Insurance — the auto + home + umbrella bundle as a bill: what it
 * costs a year and per withdrawal, how each premium moved through the term,
 * every Auto-Pay withdrawal (past and scheduled), the renewal, and the
 * documents behind it. The home is paid through the mortgage escrow, so it
 * counts in the yearly premium but not in the withdrawals. */
export function HanoverDashboard({ data, onDismissFlag }: { data: Data; onDismissFlag: (id: string) => void }) {
  const { summary: s, files, statements } = data;
  const today = nyToday();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [allChanges, setAllChanges] = useState(false);
  const fileUrl = (fileId: string) => files.find((f) => f.fileId === fileId)?.url ?? null;
  const reminderOn = s.termEnd ? addDays(s.termEnd, -data.renewal.leadDays) : null;
  const termStartTotal = s.terms.find((t) => t.termStart === s.termStart)?.startTotal ?? null;

  const series = useMemo<LineSeries[]>(() => {
    const end = s.termEnd && s.termEnd < today ? s.termEnd : today;
    return s.policies.map((p) => {
      const pts = p.history.filter((h) => h.effective <= end).map((h) => ({ x: toMs(h.effective), y: h.premium }));
      if (pts.length) pts.push({ x: toMs(end), y: pts[pts.length - 1].y });
      return { name: p.label, color: LINE_COLOR[p.line], points: pts, step: true };
    });
  }, [s.policies, s.termEnd, today]);

  const maxPay = Math.max(1, ...s.payments.map((p) => p.total));
  const checksTotal = statements.reduce((n, st) => n + st.checks.length, 0);
  const checksOk = statements.reduce((n, st) => n + st.checks.filter((c) => c.ok).length, 0);
  const notRead = files.filter((f) => f.status !== 'parsed' && f.status !== 'skipped' && f.status !== 'duplicate').length;
  const thisTermChanges = s.changes.filter((c) => !s.termStart || c.date >= s.termStart);
  const docs = [...files].sort((a, b) => b.name.localeCompare(a.name));

  return (
    <div className="fin-dash hanover-dash">
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

      <div className="dash-controls dash-controls--solo">
        <span className="dash-controls__range-text">
          {s.termStart && s.termEnd ? `Policy term ${fmtDate(s.termStart)} – ${fmtDate(s.termEnd)}` : 'No declarations read yet'}{' '}
          <InfoTip label="How Hanover is read">
            <p>Every PDF in the Hanover Insurance Drive folder is read nightly: the declarations in each policy packet or change (premium, term, vehicles, limits) and every payment schedule Hanover sends when Auto-Pay starts or a change moves the amount.</p>
            <p>
              Hanover sends no monthly bill on Auto-Pay, so each withdrawal is taken from the newest schedule issued before it. The <strong>home</strong> never appears on a schedule — it’s paid through the mortgage
              escrow — so it counts in the yearly premium but not in the withdrawals.
            </p>
            <p>Tiles follow the current policy term.</p>
          </InfoTip>
        </span>
      </div>

      <div className="fin-dash__stats">
        <button type="button" className="fin-dash__stat" onClick={() => setSheet({ kind: 'payments', title: 'Scheduled Withdrawals', filter: 'scheduled' })}>
          <span className="fin-dash__stat-label">Next Withdrawal</span>
          <span className="fin-dash__stat-value">{s.next ? money(s.next.total) : '—'}</span>
          <span className="fin-dash__stat-sub">{s.next ? `${fmtShortDate(s.next.date)} · Auto-Pay${s.last4 ? ` ••${s.last4}` : ''}` : 'Nothing scheduled'}</span>
        </button>
        <button type="button" className="fin-dash__stat" onClick={() => setSheet({ kind: 'premiums' })}>
          <span className="fin-dash__stat-label">Yearly Premium</span>
          <span className="fin-dash__stat-value">{money(s.annualPremium, false)}</span>
          <span className="fin-dash__stat-sub">
            {termStartTotal !== null && Math.abs(termStartTotal - s.annualPremium) > 0.5
              ? `${s.annualPremium > termStartTotal ? '+' : '−'}${money(Math.abs(s.annualPremium - termStartTotal), false)} since the term began`
              : `${s.policies.length} policies`}
          </span>
        </button>
        <button type="button" className="fin-dash__stat" onClick={() => setSheet({ kind: 'payments', title: 'Withdrawn This Term', filter: 'withdrawn' })}>
          <span className="fin-dash__stat-label">Paid This Term</span>
          <span className="fin-dash__stat-value">{money(s.paidThisTerm, false)}</span>
          <span className="fin-dash__stat-sub">{money(s.remainingThisTerm, false)} left · + {money(s.escrowPremium, false)} home via escrow</span>
        </button>
        <button type="button" className="fin-dash__stat" onClick={() => setSheet({ kind: 'renewal' })}>
          <span className="fin-dash__stat-label">Renews</span>
          <span className={`fin-dash__stat-value${s.renewsInDays !== null && s.renewsInDays <= data.renewal.leadDays ? ' fin-dash__neg' : ''}`}>{s.termEnd ? fmtShortDate(s.termEnd) : '—'}</span>
          <span className="fin-dash__stat-sub">
            {s.renewsInDays === null ? '' : s.renewsInDays >= 0 ? `${s.renewsInDays} days · reminder ${reminderOn ? fmtShortDate(reminderOn) : ''}` : `${-s.renewsInDays} days ago`}
          </span>
        </button>
      </div>

      <div className="fin-dash__grid">
        <section className="fin-dash__card fin-dash__card--wide">
          <DashTitle info={<p>Each policy’s yearly premium from its declarations. Steps are mid-term changes (a car added or swapped, a discount) and, from next year on, renewals.</p>}>Premium Over Time</DashTitle>
          <FinanceLineChart series={series} formatY={(v) => usd0(v)} formatX={fmtShort} ariaLabel="Hanover yearly premium by policy over time: auto, home and umbrella" />
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>The policies in force today. Tap one for its premium history and limits; the full what’s-covered notes live in the Vault entry.</p>}>Policies</DashTitle>
          <ul className="hanover-dash__policies">
            {s.policies.map((p) => (
              <li key={p.line}>
                <button type="button" onClick={() => setSheet({ kind: 'policy', policy: p })}>
                  <span className="hanover-dash__swatch" style={{ background: LINE_COLOR[p.line] }} aria-hidden />
                  <span className="hanover-dash__policy-main">
                    <strong>{p.label}</strong>
                    <span className="hanover-dash__muted">
                      {p.policyNumber} · {paidByText(p, s.last4)}
                    </span>
                    <span className="hanover-dash__muted">{keyLimits(p)}</span>
                  </span>
                  <strong>{money(p.premium, false)}</strong>
                </button>
              </li>
            ))}
            <li className="hanover-dash__total">
              <span>Total a year</span>
              <strong>{money(s.annualPremium, false)}</strong>
            </li>
          </ul>
        </section>

        <section className="fin-dash__card fin-dash__card--wide">
          <DashTitle
            info={
              <p>
                Every Auto-Pay withdrawal on the schedules in Drive (auto + umbrella{s.installmentFee ? ` + a ${money(s.installmentFee)} installment fee` : ''}). Faded bars are still to come. Payments before the first
                schedule in the folder aren’t shown.
              </p>
            }
          >
            Withdrawals
          </DashTitle>
          <div className="fin-dash__years">
            {s.payments.map((p) => (
              <div key={p.date} className={`fin-dash__year hanover-dash__pay${p.status === 'scheduled' ? ' hanover-dash__pay--scheduled' : ''}`}>
                <span className="fin-dash__year-label">{fmtShortDate(p.date)}</span>
                <span className="fin-dash__year-track">
                  <span className="fin-dash__year-bar" style={{ width: `${Math.max(2, (p.total / maxPay) * 100)}%` }} />
                </span>
                <span className="fin-dash__year-value">{money(p.total)}</span>
                <span className="fin-dash__year-bills">{p.status === 'withdrawn' ? '✓' : p === s.next ? 'Next' : ''}</span>
              </div>
            ))}
          </div>
          <p className="fin-dash__stat-sub">
            This term: {money(s.paidThisTerm)} withdrawn (incl. {money(s.feesThisTerm)} in fees) · {money(s.remainingThisTerm)} scheduled
          </p>
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>MikeOS puts a reminder on Today {data.renewal.leadDays} days before the renewal so there’s time to compare the new premiums and get quotes. It checks itself off once the new term starts.</p>}>
            Renewal
          </DashTitle>
          <dl className="adt__kv">
            <dt>Renews</dt>
            <dd>{s.termEnd ? fmtDate(s.termEnd) : '—'}</dd>
            <dt>Reminder on Today</dt>
            <dd>{reminderOn ? `${fmtDate(reminderOn)}${data.renewal.taskId ? ' · on Today now' : ''}` : '—'}</dd>
            <dt>This Term</dt>
            <dd>{termStartTotal !== null ? `${money(termStartTotal, false)} at the start → ${money(s.annualPremium, false)} now` : '—'}</dd>
            {s.upcoming && (
              <>
                <dt>Next Term</dt>
                <dd>
                  <strong>{money(s.upcoming.startTotal, false)}</strong> ({termLabel(s.upcoming.termStart, s.upcoming.termEnd)})
                </dd>
              </>
            )}
          </dl>
          {s.terms.length > 1 && (
            <ul className="fios-dash__sheet-list">
              {[...s.terms].reverse().map((t) => (
                <li key={t.termStart}>
                  <span>{termLabel(t.termStart, t.termEnd)}</span>
                  <span className="fios-dash__muted">started {money(t.startTotal, false)}</span>
                  <strong>{money(t.endTotal, false)}</strong>
                </li>
              ))}
            </ul>
          )}
          <p className="fin-dash__stat-sub">
            Quote sheets for shopping it around are in the <Link to={data.folder.vaultEntryId ? `/vault/${data.folder.vaultEntryId}` : '/vault'}>Vault notes</Link>.
          </p>
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>Each change’s effect on the yearly premium, and (in brackets) what it added to or took off the remaining withdrawals.</p>}>Changes This Term</DashTitle>
          <ul className="fios-dash__sheet-list">
            {(allChanges ? thisTermChanges : thisTermChanges.slice(0, 6)).map((c, i) => (
              <li key={`${c.date}-${c.line}-${i}`}>
                <span>{fmtShortDate(c.date)}</span>
                <span className="fios-dash__muted">
                  {c.line ? `${c.line[0].toUpperCase()}${c.line.slice(1)} · ` : ''}
                  {c.description}
                  {c.billed != null ? ` (${c.billed >= 0 ? '+' : '−'}${money(Math.abs(c.billed))} billed)` : ''}
                </span>
                <strong className={c.amount != null && c.amount < 0 ? 'fios-dash__credit' : undefined}>
                  {c.amount == null ? '—' : `${c.amount >= 0 ? '+' : '−'}${money(Math.abs(c.amount), false)}`}
                </strong>
              </li>
            ))}
          </ul>
          {thisTermChanges.length > 6 && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAllChanges((v) => !v)}>
              {allChanges ? 'Show Fewer' : `Show All ${thisTermChanges.length}`}
            </button>
          )}
        </section>

        {s.vehicles.length > 0 && (
          <section className="fin-dash__card">
            <DashTitle info={<p>The cars on the latest auto declarations, with each one’s share of the auto premium. Additional insured = the lease or loan company Hanover pays alongside you on a claim.</p>}>Vehicles</DashTitle>
            <ul className="fios-dash__sheet-list">
              {s.vehicles.map((v) => (
                <li key={v.vin}>
                  <span>
                    {v.year} {v.make} {v.model}
                  </span>
                  <span className="fios-dash__muted">
                    {v.mileage != null ? `${v.mileage.toLocaleString('en-US')} mi/yr` : ''}
                    {v.additionalInsured ? ` · ${v.additionalInsured}` : ' · no lienholder'}
                  </span>
                  <strong>{v.premium != null ? money(v.premium, false) : '—'}</strong>
                </li>
              ))}
            </ul>
            {s.defensiveDriving.perYear != null && <p className="fin-dash__stat-sub">Defensive driving discount: {money(s.defensiveDriving.perYear, false)} a year across both cars.</p>}
          </section>
        )}

        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle info={<p>Every PDF in the Drive folder and what MikeOS read from it. Math checks: each withdrawal = its policy amounts + the installment fee; the vehicle premiums add up to the auto total; standard + optional = the home total.</p>}>
            Documents
          </DashTitle>
          <div className="fin-dash__table-wrap post-table">
            <table className="fin-dash__table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Read As</th>
                  <th>Math</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((f) => {
                  const st = statements.find((x) => x.fileId === f.fileId);
                  const kind = st ? st.periodEnd.slice(11) : null;
                  const failed = st?.checks.filter((c) => !c.ok).length ?? 0;
                  return (
                    <tr key={f.fileId}>
                      <td>
                        {f.url ? (
                          <a href={f.url} target="_blank" rel="noreferrer">
                            {f.name}
                          </a>
                        ) : (
                          f.name
                        )}
                      </td>
                      <td>{st ? `${kind === 'bill' ? 'Payment schedule' : `${kind ? kind[0].toUpperCase() + kind.slice(1) : ''} declarations`} · ${fmtDate(st.periodEnd)}` : f.status === 'skipped' ? 'Skipped' : `Not read — ${f.error ?? f.status}`}</td>
                      <td>{st ? (failed ? `✕ ${failed} failed` : st.checks.length ? `✓ ${st.checks.length}/${st.checks.length}` : '—') : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="post-cards">
            {docs.map((f) => {
              const st = statements.find((x) => x.fileId === f.fileId);
              const kind = st ? st.periodEnd.slice(11) : null;
              return (
                <li key={`c-${f.fileId}`}>
                  <a className="post-card" href={f.url ?? undefined} target="_blank" rel="noreferrer">
                    <span className="post-card__top">{st ? `${kind === 'bill' ? 'Payment schedule' : `${kind ? kind[0].toUpperCase() + kind.slice(1) : ''} declarations`} · ${fmtDate(st.periodEnd)}` : f.status}</span>
                    <span className="post-card__title">{f.name}</span>
                  </a>
                </li>
              );
            })}
          </ul>
          <p className="fin-dash__stat-sub">
            {statements.length} documents read · {checksOk}/{checksTotal} math checks passed
            {notRead > 0 && ` · ${notRead} file(s) not read`}
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
                <Link to={`/vault/${data.folder.vaultEntryId}`}>Vault Entry</Link>
              </>
            )}
            {data.template?.site && (
              <>
                {' · '}
                <a href={data.template.site} target="_blank" rel="noreferrer">
                  My Hanover ↗
                </a>
              </>
            )}
          </p>
        </section>
      </div>

      {sheet?.kind === 'payments' && (
        <DetailSheet
          title={sheet.title}
          sub={(() => {
            const rows = s.payments.filter((p) => sheet.filter === 'all' || p.status === sheet.filter);
            return `${rows.length} withdrawal${rows.length === 1 ? '' : 's'} · ${money(rows.reduce((a, p) => a + p.total, 0))}`;
          })()}
          onClose={() => setSheet(null)}
        >
          <ul className="fios-dash__sheet-list">
            {s.payments
              .filter((p) => sheet.filter === 'all' || p.status === sheet.filter)
              .map((p) => (
                <li key={p.date}>
                  <span>{fmtDate(p.date)}</span>
                  <span className="fios-dash__muted">
                    Auto {p.byLine.auto != null ? money(p.byLine.auto) : '—'} · Umbrella {p.byLine.umbrella != null ? money(p.byLine.umbrella) : '—'}
                    {p.fee ? ` · fee ${money(p.fee)}` : ''}
                  </span>
                  <strong>{money(p.total)}</strong>
                </li>
              ))}
          </ul>
          <p className="fin-dash__stat-sub">Amounts from the schedule dated {s.payments.length ? fmtDate(s.payments[s.payments.length - 1].notice) : '—'} and earlier ones; Auto-Pay from bank account{s.last4 ? ` ••${s.last4}` : ''}.</p>
        </DetailSheet>
      )}
      {sheet?.kind === 'premiums' && (
        <DetailSheet title="Yearly Premium" sub={`${money(s.annualPremium)} · ${money(s.billedPremium)} by Auto-Pay + ${money(s.escrowPremium)} through escrow`} onClose={() => setSheet(null)}>
          <ul className="fios-dash__sheet-list">
            {s.policies.map((p) => (
              <li key={p.line}>
                <button type="button" onClick={() => setSheet({ kind: 'policy', policy: p })}>
                  <span>{p.label}</span>
                  <span className="fios-dash__muted">
                    {paidByText(p, s.last4)}
                    {p.termStartPremium !== p.premium ? ` · started the term at ${money(p.termStartPremium, false)}` : ''}
                  </span>
                  <strong>{money(p.premium, false)}</strong>
                </button>
              </li>
            ))}
          </ul>
        </DetailSheet>
      )}
      {sheet?.kind === 'policy' && (
        <DetailSheet title={`${sheet.policy.label} · ${sheet.policy.policyNumber}`} sub={`${money(sheet.policy.premium)} a year · ${paidByText(sheet.policy, s.last4)}`} onClose={() => setSheet(null)}>
          <dl className="adt__kv">
            <dt>Term</dt>
            <dd>
              {fmtDate(sheet.policy.termStart)} – {fmtDate(sheet.policy.termEnd)}
            </dd>
            {sheet.policy.line === 'auto' && (
              <>
                <dt>Liability</dt>
                <dd>{usd0(sheet.policy.current.liabilityCsl)} combined single limit</dd>
                <dt>Uninsured / Underinsured</dt>
                <dd>{usd0(sheet.policy.current.sum)}</dd>
                <dt>Medical Payments</dt>
                <dd>{usd0(sheet.policy.current.medPay)} per person</dd>
                <dt>Deductibles</dt>
                <dd>
                  {usd0(sheet.policy.current.collisionDeductible)} collision · {usd0(sheet.policy.current.comprehensiveDeductible)} comprehensive{sheet.policy.current.fullGlass ? ' · full glass' : ''}
                </dd>
              </>
            )}
            {sheet.policy.line === 'home' && (
              <>
                <dt>Dwelling</dt>
                <dd>{usd0(sheet.policy.current.dwelling)}</dd>
                <dt>Other Structures</dt>
                <dd>{usd0(sheet.policy.current.otherStructures)}</dd>
                <dt>Personal Property</dt>
                <dd>{usd0(sheet.policy.current.personalProperty)}</dd>
                <dt>Loss of Use</dt>
                <dd>{sheet.policy.current.lossOfUse ? sheet.policy.current.lossOfUse.toLowerCase().replace(/^./, (c) => c.toUpperCase()) : '—'}</dd>
                <dt>Liability</dt>
                <dd>{usd0(sheet.policy.current.personalLiability)}</dd>
                <dt>Deductible</dt>
                <dd>{usd0(sheet.policy.current.deductible)}</dd>
                <dt>Mortgagee</dt>
                <dd>{sheet.policy.current.mortgagee ?? '—'}</dd>
              </>
            )}
            {sheet.policy.line === 'umbrella' && (
              <>
                <dt>Limit</dt>
                <dd>{usd0(sheet.policy.current.limit)} per occurrence</dd>
                <dt>Excess UM/UIM</dt>
                <dd>{usd0(sheet.policy.current.excessUm)}</dd>
                <dt>Retained Limit</dt>
                <dd>{usd0(sheet.policy.current.retainedLimit)}</dd>
              </>
            )}
          </dl>
          <h4>Premium History</h4>
          <ul className="fios-dash__sheet-list">
            {[...sheet.policy.history].reverse().map((h) => {
              const url = fileUrl(h.fileId);
              return (
                <li key={`${h.effective}-${h.fileId}`}>
                  <span>{fmtDate(h.effective)}</span>
                  <span className="fios-dash__muted">
                    {h.reason}
                    {url && (
                      <>
                        {' · '}
                        <a href={url} target="_blank" rel="noreferrer">
                          PDF ↗
                        </a>
                      </>
                    )}
                  </span>
                  <strong>{money(h.premium, false)}</strong>
                </li>
              );
            })}
          </ul>
        </DetailSheet>
      )}
      {sheet?.kind === 'renewal' && (
        <DetailSheet title="Renewal" sub={s.termEnd ? `Renews ${fmtDate(s.termEnd)}` : undefined} onClose={() => setSheet(null)}>
          <p>
            All {s.policies.length} Hanover policies renew together on {s.termEnd ? fmtDate(s.termEnd) : '—'}. A reminder lands on Today {reminderOn ? fmtDate(reminderOn) : ''} — {data.renewal.leadDays} days ahead — so
            there’s time to compare the renewal premiums and get quotes on the whole bundle.
          </p>
          <p>When the renewal declarations and payment schedule arrive, drop them in the Drive folder; the new premiums show here (Next Term) and a jump of 10% or more on any policy gets flagged.</p>
        </DetailSheet>
      )}
    </div>
  );
}

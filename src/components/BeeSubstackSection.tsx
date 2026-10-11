import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BeePost, BeeSpotlightPerson, BeeSubPerson, BeeSubstack, BeeYear } from '../api/types';
import { FinanceLineChart } from './FinanceLineChart';
import type { LineSeries } from './FinanceLineChart';
import { SectionPicker } from './dash/SectionPicker';
import { RangePicker } from './dash/RangePicker';
import { DashTitle, InfoTip } from './dash/InfoTip';
import { DetailSheet } from './dash/DetailSheet';
import { clampRange } from './dash/useUrlRange';
import { type DateRange, addDays, bucketFor, bucketStart, bucketsIn, dayMs, inRange, previousRange, rangeText } from '../utils/dateRange';

/** Bedford Bee → Substack, on the dashboard kit (Mike, 2026-10-11): the
 * shared date range drives every tile and list, every number opens its
 * detail, explainers sit behind ⓘ. Everything is computed here from the
 * /api/bee/substack payload (posts, people with their dates, Stripe
 * charges) — the export is small, so any range is instant. Spotlight is
 * the exception: Substack's export only knows the last 6 months. */

const TOTAL_COLOR = '#2A6FB0';
const PAID_COLOR = '#C0662E';
const KIND_LABEL: Record<string, string> = { posts: 'Posts', subscribers: 'Subscribers', stripe: 'Stripe', other: 'Not Recognized' };

const toMs = (iso: string) => dayMs(iso.slice(0, 10));
const fmtDate = (iso: string | null) => (iso ? new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const fmtShortDate = (iso: string) => new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
const fmtMonth = (ym: string) => new Date(toMs(`${ym}-15`)).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
const money = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number | null, digits = 0) => (n === null || !isFinite(n) ? '—' : `${(n * 100).toFixed(digits)}%`);
const x1 = (n: number | null) => (n === null ? '—' : `${n.toFixed(1)}×`);
const n0 = (n: number) => Math.round(n).toLocaleString('en-US');
const d10 = (iso: string) => iso.slice(0, 10);

// ---- Subscriber math (mirrors worker/src/bee/summary.ts year review)
const alive = (p: BeeSubPerson, at: string) => !!p.start && p.start <= at && (p.active || !p.left || p.left > at);
function paidAt(p: BeeSubPerson, at: string, today: string) {
  if (!p.firstPaid || p.firstPaid > at || !alive(p, at)) return false;
  if (at >= today) return p.paidNow;
  return !(p.cancelled && p.expires && p.expires <= at);
}

function changeText(now: number, prev: number | null, label: string | null, invert = false) {
  if (prev == null || label == null) return { text: '', tone: '' as '' | 'up' | 'down' };
  if (!prev) return now ? { text: `new vs ${label}`, tone: (invert ? 'down' : 'up') as 'up' | 'down' } : { text: '', tone: '' as const };
  const d = (now - prev) / prev;
  if (Math.abs(d) < 0.05) return { text: `≈ ${label}`, tone: '' as const };
  const up = d > 0;
  return { text: `${up ? '+' : '−'}${Math.abs(d * 100).toFixed(0)}% vs ${label}`, tone: (up !== invert ? 'up' : 'down') as 'up' | 'down' };
}
const toneClass = (t: '' | 'up' | 'down') => (t === 'up' ? ' bee-delta--up' : t === 'down' ? ' bee-delta--down' : '');

type Sheet =
  | { kind: 'subscribers' | 'joined' | 'paid' | 'openRate' | 'revenue' }
  | { kind: 'month'; month: string }
  | { kind: 'source'; channel: string }
  | { kind: 'post'; post: BeePost };

export function BeeSubstackSection({
  data,
  range: rangeIn,
  setRange,
  onScan,
  scanning,
  scanMsg,
}: {
  data: BeeSubstack;
  range: DateRange;
  setRange: (r: DateRange) => void;
  onScan: () => void;
  scanning: boolean;
  scanMsg: string | null;
}) {
  const empty = !data.files.some((f) => f.status === 'parsed');
  const today = data.today;
  const earliest = useMemo(() => {
    const starts = [...data.people.map((p) => p.start ?? ''), ...data.posts.map((p) => d10(p.date))].filter(Boolean).sort();
    return starts[0] ?? today;
  }, [data, today]);
  const range = clampRange(rangeIn, earliest);
  const prevR = previousRange(range);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const s = useMemo(() => stats(data, range, prevR), [data, range, prevR]);
  const prevLabel = prevR ? (range.key === 'ytd' ? 'last year' : prevR.label) : null;

  return (
    <section className="bee-section">
      <div className="bee-section__head">
        <h2 className="bee-section__title">Substack</h2>
        <span className="fin-dash__muted">
          {data.asOf.posts || data.asOf.subscribers ? `Exports from ${fmtDate([data.asOf.posts, data.asOf.subscribers, data.asOf.stripe].filter(Boolean).sort()[0] ?? null)}` : 'No exports read yet'}
        </span>
      </div>

      {data.exportTask && data.exportTask.status === 'open' && data.exportTask.missing.length > 0 && (
        <div className="fin-dash__flag fin-dash__flag--warn bee-export-banner">
          <span className="fin-dash__flag-icon">⏰</span>
          <span className="fin-dash__flag-msg">
            Monthly export due {fmtDate(data.exportTask.dueDate)} — still need: {data.exportTask.missing.map((k) => KIND_LABEL[k]).join(', ')}. Drop them in the{' '}
            {data.settings.folderUrl ? (
              <a href={data.settings.folderUrl} target="_blank" rel="noopener noreferrer">
                {data.settings.folderName ?? 'Bedford Bee'} folder
              </a>
            ) : (
              'Bedford Bee folder'
            )}
            .
          </span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onScan} disabled={scanning}>
            {scanning ? 'Scanning…' : 'Scan Now'}
          </button>
        </div>
      )}

      {empty ? (
        <div className="fin-dash__card">
          <p>
            Put Substack’s posts export, subscriber export and Stripe’s balance history (CSV) in a Google Drive folder named <strong>Bedford Bee</strong>, then scan.
          </p>
          <button type="button" className="btn btn--sm" onClick={onScan} disabled={scanning}>
            {scanning ? 'Scanning…' : 'Scan Now'}
          </button>
          {scanMsg && <p className="fin-dash__note">{scanMsg}</p>}
        </div>
      ) : (
        <>
          <div className="dash-controls dash-controls--solo">
            <RangePicker value={range} onChange={setRange} today={today} earliest={earliest} />
            <span className="dash-controls__range-text">
              {rangeText(range)}
              {prevR ? ` · vs ${rangeText(prevR)}` : ''}{' '}
              <InfoTip label="About these numbers">
                <p>Subscribers and Paid are counts at the end of the range. Joined counts people whose subscription started in the range (including anyone who has since left).</p>
                <p>Open rate = unique openers ÷ delivered across the emails sent in the range. Net revenue = Stripe charges in the range after Substack’s 10%, card processing and Stripe Billing.</p>
                <p>People who left are only known from {data.firstSubscriberExport ? fmtDate(data.firstSubscriberExport) : 'the first subscriber export'} on — each monthly export is compared with the one before.</p>
              </InfoTip>
            </span>
          </div>

          <div className="fin-dash__stats fin-dash__stats--5">
            <Tile
              label="Subscribers"
              value={n0(s.subsEnd)}
              sub={`${s.subsEnd - s.subsStart >= 0 ? '+' : '−'}${Math.abs(s.subsEnd - s.subsStart)} in range${s.left.length ? ` · ${s.left.length} left` : ''}`}
              tone={s.subsEnd > s.subsStart ? 'up' : s.subsEnd < s.subsStart ? 'down' : ''}
              onClick={() => setSheet({ kind: 'subscribers' })}
            />
            <Tile
              label="Joined"
              value={n0(s.joined.length)}
              {...(() => {
                const c = changeText(s.joined.length, s.prev ? s.prev.joined : null, prevLabel);
                return { sub: c.text || 'new subscribers', tone: c.tone };
              })()}
              onClick={() => setSheet({ kind: 'joined' })}
            />
            <Tile label="Paid" value={n0(s.paidEnd)} sub={`${s.startedPaying.length} started paying${s.paidStopped.length ? ` · ${s.paidStopped.length} stopped` : ''}`} onClick={() => setSheet({ kind: 'paid' })} />
            <Tile
              label="Open Rate"
              value={pct(s.openRate)}
              {...(() => {
                const c = s.prev && s.prev.openRate != null && s.openRate != null ? changeText(s.openRate, s.prev.openRate, prevLabel) : { text: '', tone: '' as const };
                return { sub: c.text || `${s.emailed.length} email${s.emailed.length === 1 ? '' : 's'}`, tone: c.tone };
              })()}
              onClick={() => setSheet({ kind: 'openRate' })}
            />
            <Tile
              label="Net Revenue"
              value={money(s.net)}
              {...(() => {
                const c = changeText(s.net, s.prev ? s.prev.net : null, prevLabel);
                return { sub: c.text || `${s.charges.length} charge${s.charges.length === 1 ? '' : 's'}`, tone: c.tone };
              })()}
              onClick={() => setSheet({ kind: 'revenue' })}
            />
          </div>

          <div className="fin-dash__grid">
            <GrowthCard data={data} range={range} />
            <GainedLostCard data={data} range={range} onOpen={(month) => setSheet({ kind: 'month', month })} />
            <SourcesCard joined={s.joined} onOpen={(channel) => setSheet({ kind: 'source', channel })} />
            <RenewalsCard data={data} />
            <PostsCard data={data} posts={s.posts} onOpen={(post) => setSheet({ kind: 'post', post })} />
            <SpotlightCard data={data} />
            <MoneyCard data={data} />
            <YearCard data={data} />
            <FilesCard data={data} onScan={onScan} scanning={scanning} scanMsg={scanMsg} />
          </div>
        </>
      )}

      {sheet && <SubstackSheet sheet={sheet} data={data} range={range} s={s} onClose={() => setSheet(null)} onOpen={setSheet} />}
    </section>
  );
}

type Stats = ReturnType<typeof stats>;
function stats(data: BeeSubstack, range: { from: string; to: string }, prevR: { from: string; to: string } | null) {
  const today = data.today;
  const dayBefore = addDays(range.from, -1);
  const people = data.people;
  const one = (r: { from: string; to: string }) => {
    const joined = people.filter((p) => p.start && inRange(p.start, r));
    const posts = data.posts.filter((p) => inRange(d10(p.date), r));
    const emailed = posts.filter((p) => p.emailed && p.delivered > 0);
    const delivered = emailed.reduce((n, p) => n + p.delivered, 0);
    const opened = emailed.reduce((n, p) => n + p.opened, 0);
    const charges = data.money.charges.filter((c) => inRange(c.date, r));
    return { joined, posts, emailed, openRate: delivered ? opened / delivered : null, charges, net: charges.reduce((n, c) => n + c.net, 0), gross: charges.reduce((n, c) => n + c.amount, 0) };
  };
  const cur = one(range);
  const prev = prevR ? one(prevR) : null;
  return {
    ...cur,
    subsStart: people.filter((p) => alive(p, dayBefore)).length,
    subsEnd: people.filter((p) => alive(p, range.to)).length,
    paidStart: people.filter((p) => paidAt(p, dayBefore, today)).length,
    paidEnd: people.filter((p) => paidAt(p, range.to, today)).length,
    left: people.filter((p) => p.left && inRange(p.left, range)),
    startedPaying: people.filter((p) => p.firstPaid && inRange(p.firstPaid, range)),
    paidStopped: people.filter((p) => paidAt(p, dayBefore, today) && !paidAt(p, range.to, today)),
    prev: prev ? { joined: prev.joined.length, openRate: prev.openRate, net: prev.net } : null,
  };
}

function Tile({ label, value, sub, tone, onClick }: { label: string; value: string; sub?: string; tone?: '' | 'up' | 'down'; onClick: () => void }) {
  return (
    <button type="button" className="fin-dash__stat" onClick={onClick}>
      <span className="fin-dash__stat-label">{label}</span>
      <span className="fin-dash__stat-value">{value}</span>
      {sub && <span className={`fin-dash__stat-sub${toneClass(tone ?? '')}`}>{sub}</span>}
    </button>
  );
}

// ---------------------------------------------------------------- sheets

function SubstackSheet({
  sheet,
  data,
  range,
  s,
  onClose,
  onOpen,
}: {
  sheet: Sheet;
  data: BeeSubstack;
  range: DateRange;
  s: Stats;
  onClose: () => void;
  onOpen: (s: Sheet) => void;
}) {
  const sub = `${range.label} · ${rangeText(range)}`;
  if (sheet.kind === 'subscribers')
    return (
      <DetailSheet title="Subscribers" sub={sub} onClose={onClose}>
        <Split
          items={[
            ['At Start', n0(s.subsStart), fmtDate(addDays(range.from, -1))],
            ['At End', n0(s.subsEnd), fmtDate(range.to)],
            ['Joined', `+${s.joined.length}`, ''],
            ['Left', s.left.length ? `−${s.left.length}` : '0', ''],
          ]}
        />
        <Section title="Over Time">
          <GrowthChart data={data} range={range} />
        </Section>
        <Section title={`Joined (${s.joined.length})`}>
          <PeopleList people={s.joined} meta={(p) => `${fmtShortDate(p.start!)} · ${p.source}${!p.active ? ' · since left' : ''}`} />
        </Section>
        <Section title={`Left (${s.left.length})`}>
          <PeopleList people={s.left} meta={(p) => `Left ${fmtShortDate(p.left!)} · joined ${p.start ? fmtShortDate(p.start) : '—'}`} empty="Nobody left in this range." />
        </Section>
      </DetailSheet>
    );
  if (sheet.kind === 'joined') {
    const bucket = bucketFor(range);
    const buckets = bucketsIn(range, bucket);
    const count = (list: BeeSubPerson[]) => {
      const m = new Map(buckets.map((b) => [b, 0]));
      for (const p of list) {
        const b = bucketStart(p.start!, bucket);
        if (m.has(b)) m.set(b, (m.get(b) ?? 0) + 1);
      }
      return buckets.map((b) => ({ x: dayMs(b), y: m.get(b) ?? 0 }));
    };
    const channels = tallyBy(s.joined, (p) => p.source);
    return (
      <DetailSheet title="Joined" sub={sub} onClose={onClose}>
        <Split
          items={[
            ['Joined', n0(s.joined.length), s.prev ? `${n0(s.prev.joined)} before` : ''],
            ['Still Here', n0(s.joined.filter((p) => p.active).length), ''],
            ['Paid Right Away', n0(s.joined.filter((p) => p.firstPaid && p.start && p.firstPaid <= addDays(p.start, 1)).length), ''],
          ]}
        />
        <Section title={`By ${bucket === 'day' ? 'Day' : bucket === 'week' ? 'Week' : 'Month'}`}>
          <FinanceLineChart series={[{ name: 'Joined', color: TOTAL_COLOR, points: count(s.joined) }]} formatY={n0} formatX={axisFor(bucket)} ariaLabel="New subscribers over time" height={180} />
        </Section>
        <Section title="Where They Came From">
          <Bars rows={channels.map(([k, v]) => ({ key: k, label: k, value: v }))} onClick={(k) => onOpen({ kind: 'source', channel: k })} />
        </Section>
        <Section title="People">
          <PeopleList people={s.joined} meta={(p) => `${fmtShortDate(p.start!)} · ${p.source}${!p.active ? ' · since left' : ''}`} />
        </Section>
      </DetailSheet>
    );
  }
  if (sheet.kind === 'paid')
    return (
      <DetailSheet title="Paid Subscribers" sub={sub} onClose={onClose}>
        <Split
          items={[
            ['At Start', n0(s.paidStart), ''],
            ['At End', n0(s.paidEnd), ''],
            ['Started Paying', `+${s.startedPaying.length}`, `${s.startedPaying.filter((p) => p.upgraded).length} upgrades`],
            ['Stopped', s.paidStopped.length ? `−${s.paidStopped.length}` : '0', ''],
          ]}
        />
        <Section title="Over Time">
          <GrowthChart data={data} range={range} paidOnly />
        </Section>
        <Section title="Started Paying">
          <PeopleList people={s.startedPaying} meta={(p) => `${fmtShortDate(p.firstPaid!)} · ${p.upgraded ? 'upgraded from free' : 'paid from the start'}${p.paidSource ? ` · ${p.paidSource}` : ''}`} empty="Nobody started paying in this range." />
        </Section>
        <Section title="Stopped Paying">
          <PeopleList people={s.paidStopped} meta={(p) => (p.left ? `Left ${fmtShortDate(p.left)}` : p.expires ? `Plan ended ${fmtShortDate(p.expires)}` : 'Plan ended')} empty="Nobody stopped paying in this range." />
        </Section>
      </DetailSheet>
    );
  if (sheet.kind === 'openRate') {
    const posts = [...s.emailed].sort((a, b) => a.date.localeCompare(b.date));
    return (
      <DetailSheet title="Open Rate" sub={sub} onClose={onClose}>
        <Split
          items={[
            ['Open Rate', pct(s.openRate), s.prev && s.prev.openRate != null ? `${pct(s.prev.openRate)} before` : ''],
            ['Emails', n0(s.emailed.length), ''],
            ['Delivered', n0(s.emailed.reduce((n, p) => n + p.delivered, 0)), ''],
            ['Opened', n0(s.emailed.reduce((n, p) => n + p.opened, 0)), 'unique readers'],
          ]}
        />
        {posts.length > 1 && (
          <Section title="Each Email">
            <FinanceLineChart
              series={[{ name: 'Open rate', color: TOTAL_COLOR, points: posts.map((p) => ({ x: toMs(p.date), y: (p.openRate ?? 0) * 100 })) }]}
              formatY={(v) => `${Math.round(v)}%`}
              formatX={(ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              ariaLabel="Open rate per email"
              height={180}
              yFromZero={false}
            />
          </Section>
        )}
        <Section title="Best Headlines">
          <PostList posts={[...s.emailed].sort((a, b) => (b.openRate ?? 0) - (a.openRate ?? 0))} med={data.postMedians} onOpen={(post) => onOpen({ kind: 'post', post })} />
        </Section>
      </DetailSheet>
    );
  }
  if (sheet.kind === 'revenue') {
    const fees = s.charges.reduce((n, c) => n + c.fee, 0);
    return (
      <DetailSheet title="Net Revenue" sub={sub} onClose={onClose}>
        <Split
          items={[
            ['Gross', money(s.gross), ''],
            ['Fees', money(-fees), 'Substack + processing'],
            ['Net', money(s.net), s.prev ? `${money(s.prev.net)} before` : ''],
          ]}
        />
        <p className="fin-dash__muted">Stripe Billing’s small 0.7% usage fee posts separately and is counted in the yearly table, not here.</p>
        <Section title={`Charges (${s.charges.length})`}>
          <ChargesTable charges={s.charges} />
        </Section>
      </DetailSheet>
    );
  }
  if (sheet.kind === 'month') {
    const [yy, mm] = sheet.month.split('-').map(Number);
    const r = { from: `${sheet.month}-01`, to: `${sheet.month}-${String(new Date(yy, mm, 0).getDate()).padStart(2, '0')}` };
    const joined = data.people.filter((p) => p.start && inRange(p.start, r));
    const upgraded = data.people.filter((p) => p.upgraded && p.firstPaid && inRange(p.firstPaid, r));
    const left = data.people.filter((p) => p.left && inRange(p.left, r));
    const cancelled = data.people.filter((p) => p.cancelled && inRange(p.cancelled, r));
    return (
      <DetailSheet title={fmtMonth(sheet.month)} sub="Who joined, upgraded and left" onClose={onClose}>
        <Section title={`Joined (${joined.length})`}>
          <PeopleList people={joined} meta={(p) => `${fmtShortDate(p.start!)} · ${p.source}${p.firstPaid && p.start && p.firstPaid <= addDays(p.start, 1) ? ' · paid' : ''}`} empty="Nobody joined." />
        </Section>
        <Section title={`Upgraded to Paid (${upgraded.length})`}>
          <PeopleList people={upgraded} meta={(p) => fmtShortDate(p.firstPaid!)} empty="No upgrades." />
        </Section>
        <Section title={`Left (${left.length})`}>
          <PeopleList people={left} meta={(p) => fmtShortDate(p.left!)} empty="Nobody left." />
        </Section>
        {cancelled.length > 0 && (
          <Section title={`Cancelled a Paid Plan (${cancelled.length})`}>
            <PeopleList people={cancelled} meta={(p) => `${fmtShortDate(p.cancelled!)}${p.expires ? ` · ends ${fmtShortDate(p.expires)}` : ''}`} />
          </Section>
        )}
      </DetailSheet>
    );
  }
  if (sheet.kind === 'source') {
    const list = s.joined.filter((p) => p.source === sheet.channel);
    const raw = tallyBy(list, (p) => p.sourceRaw ?? '—');
    return (
      <DetailSheet title={sheet.channel} sub={`Joined in ${rangeText(range)}`} onClose={onClose}>
        <Split
          items={[
            ['Joined', n0(list.length), ''],
            ['Still Here', n0(list.filter((p) => p.active).length), ''],
            ['Paid Now', n0(list.filter((p) => p.paidNow).length), ''],
          ]}
        />
        {raw.length > 1 || raw[0]?.[0] !== sheet.channel ? (
          <Section title="Exact Sources">
            <Bars rows={raw.map(([k, v]) => ({ key: k, label: k, value: v }))} />
          </Section>
        ) : null}
        <Section title="People">
          <PeopleList people={list} meta={(p) => `${fmtShortDate(p.start!)}${p.paidNow ? ' · paid' : ''}${!p.active ? ' · since left' : ''}`} />
        </Section>
      </DetailSheet>
    );
  }
  if (sheet.kind !== 'post') return null;
  const p = sheet.post;
  const med = data.postMedians;
  return (
    <DetailSheet title={p.title} sub={`${fmtDate(p.date)}${p.emailed ? '' : ' · web only'}`} onClose={onClose}>
      <Split
        items={[
          ['Open Rate', pct(p.openRate), med.openRate != null ? `typical ${pct(med.openRate)}` : ''],
          ['Opens / Reader', x1(p.ratio), med.ratio != null ? `typical ${x1(med.ratio)}` : ''],
          ['Views', n0(p.views), med.views != null ? `typical ${n0(med.views)}` : ''],
          ['Clicks', n0(p.clicks), ''],
        ]}
      />
      <Split
        items={[
          ['Sent', p.emailed ? n0(p.sent) : '—', p.emailed ? `${n0(p.delivered)} delivered` : ''],
          ['Opened', p.emailed ? n0(p.opened) : '—', p.emailed ? `${n0(p.opens)} opens in all` : ''],
          ['Reactions', n0(p.likes + p.comments + p.shares + p.restacks), `${p.likes} likes · ${p.comments} comments · ${p.shares + p.restacks} shares`],
          ['Gained', `+${p.signups} free · +${p.paid} paid`, p.unsubscribes ? `${p.unsubscribes} unsubscribed` : ''],
        ]}
      />
      {p.opensDay7 != null && (
        <p className="fin-dash__muted">
          Opens after 7 days: {n0(p.opensDay7)}
          {p.opensDay28 != null ? ` · after 28 days: ${n0(p.opensDay28)}` : ''}
        </p>
      )}
    </DetailSheet>
  );
}

const axisFor = (bucket: 'day' | 'week' | 'month') => (ms: number) => new Date(ms).toLocaleDateString('en-US', bucket === 'month' ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' });

function tallyBy<T>(list: T[], key: (t: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const t of list) m.set(key(t), (m.get(key(t)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function Split({ items }: { items: [string, string, string][] }) {
  return (
    <div className="dash-split">
      {items.map(([label, value, sub]) => (
        <div key={label} className="dash-split__item">
          <span className="fin-dash__stat-label">{label}</span>
          <span className="dash-split__value">{value}</span>
          {sub && <span className="fin-dash__stat-sub">{sub}</span>}
        </div>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="dash-sheet__section">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

function Bars({ rows, onClick }: { rows: { key: string; label: string; value: number; sub?: string }[]; onClick?: (key: string) => void }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="bee-bars">
      {rows.map((r) => {
        const inner = (
          <>
            <span className="bee-bars__label">{r.label}</span>
            <span className="bee-bars__track">
              <span className="bee-bars__bar" style={{ width: `${(r.value / max) * 100}%` }} />
            </span>
            <span className="bee-bars__value">
              {r.value}
              {r.sub ? <span className="bee-bars__paid"> · {r.sub}</span> : null}
            </span>
          </>
        );
        return onClick ? (
          <button key={r.key} type="button" className="bee-bars__row" onClick={() => onClick(r.key)}>
            {inner}
          </button>
        ) : (
          <div key={r.key} className="bee-bars__row bee-bars__row--static">
            {inner}
          </div>
        );
      })}
    </div>
  );
}

function PeopleList({ people, meta, empty = 'Nobody.' }: { people: BeeSubPerson[]; meta: (p: BeeSubPerson) => string; empty?: string }) {
  const [all, setAll] = useState(false);
  if (!people.length) return <p className="fin-dash__muted">{empty}</p>;
  const shown = all ? people : people.slice(0, 30);
  return (
    <>
      <ul className="bee-list">
        {shown.map((p) => (
          <li key={p.email} className="bee-list__row">
            <PersonName name={p.name} email={p.email} contactId={p.contactId} />
            <span className="bee-list__meta">{meta(p)}</span>
          </li>
        ))}
      </ul>
      {people.length > shown.length && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAll(true)}>
          Show All {people.length}
        </button>
      )}
    </>
  );
}

function PersonName({ name, email, contactId }: { name: string | null; email: string; contactId: string | null }) {
  const label = name || email;
  return (
    <span className="bee-person">
      {contactId && contactId !== 'none' ? <Link to={`/contacts/${contactId}`}>{label}</Link> : label}
      {name && <span className="bee-person__email">{email}</span>}
    </span>
  );
}

function ChargesTable({ charges }: { charges: BeeSubstack['money']['charges'] }) {
  if (!charges.length) return <p className="fin-dash__muted">No charges in this range.</p>;
  return (
    <div className="fin-dash__table-wrap">
      <table className="fin-dash__table bee-table--compact">
        <thead>
          <tr>
            <th>Date</th>
            <th>Type</th>
            <th className="num">Amount</th>
            <th className="num bee-hide-sm">Fee</th>
            <th className="num">Net</th>
          </tr>
        </thead>
        <tbody>
          {charges.map((c) => (
            <tr key={c.id}>
              <td>{fmtShortDate(c.date)}</td>
              <td>{/creation/i.test(c.description ?? '') ? 'New' : /update/i.test(c.description ?? '') ? 'Renewal' : (c.description ?? c.type)}</td>
              <td className="num">{money(c.amount)}</td>
              <td className="num fin-dash__muted bee-hide-sm">{money(-c.fee)}</td>
              <td className="num">{money(c.net)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- cards

function GrowthChart({ data, range, paidOnly }: { data: BeeSubstack; range: { from: string; to: string }; paidOnly?: boolean }) {
  const series = useMemo<LineSeries[]>(() => {
    const g = data.growth;
    const before = [...g].filter((p) => p.date < range.from).pop();
    const pts = [...(before ? [{ ...before, date: range.from }] : []), ...g.filter((p) => inRange(p.date, range))];
    if (pts.length && pts[pts.length - 1].date < range.to) pts.push({ ...pts[pts.length - 1], date: range.to });
    const out: LineSeries[] = [];
    if (!paidOnly) out.push({ name: 'All Subscribers', color: TOTAL_COLOR, step: true, points: pts.map((p) => ({ x: toMs(p.date), y: p.total })) });
    out.push({ name: 'Paid', color: PAID_COLOR, step: true, points: pts.map((p) => ({ x: toMs(p.date), y: p.paid })) });
    return out;
  }, [data.growth, range, paidOnly]);
  if ((series[0]?.points.length ?? 0) < 2) return <p className="fin-dash__muted">Not enough history in this range.</p>;
  return (
    <FinanceLineChart
      series={series}
      formatY={(v) => n0(v)}
      formatX={(ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}
      ariaLabel="Subscribers over time"
      yFromZero={false}
    />
  );
}

function GrowthCard({ data, range }: { data: BeeSubstack; range: { from: string; to: string } }) {
  return (
    <section className="fin-dash__card fin-dash__card--wide">
      <DashTitle
        info={
          <p>
            From each subscriber’s start and first paid dates. People who left only count from {data.firstSubscriberExport ? fmtDate(data.firstSubscriberExport) : 'the first export'} on — each monthly
            subscriber export is compared with the one before.
          </p>
        }
      >
        Subscribers Over Time
      </DashTitle>
      <GrowthChart data={data} range={range} />
    </section>
  );
}

function GainedLostCard({ data, range, onOpen }: { data: BeeSubstack; range: { from: string; to: string }; onOpen: (month: string) => void }) {
  const rows = data.months.filter((r) => r.month >= range.from.slice(0, 7) && r.month <= range.to.slice(0, 7));
  return (
    <section className="fin-dash__card">
      <DashTitle info={<p>Free = joined without paying. Paid = paid within a day of joining. Upgrades = free subscribers who started paying later. Tap a month for the people.</p>}>Gained &amp; Lost</DashTitle>
      {rows.length ? (
        <div className="fin-dash__table-wrap">
          <table className="fin-dash__table bee-table--compact">
            <thead>
              <tr>
                <th>Month</th>
                <th className="num">Free</th>
                <th className="num">Paid</th>
                <th className="num">Upgrades</th>
                <th className="num">Left</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.month} className="bee-social__row" onClick={() => onOpen(r.month)}>
                  <td>{fmtMonth(r.month)}</td>
                  <td className="num">{r.freeJoined ? `+${r.freeJoined}` : '—'}</td>
                  <td className="num">{r.paidJoined ? `+${r.paidJoined}` : '—'}</td>
                  <td className="num">{r.upgrades ? `+${r.upgrades}` : '—'}</td>
                  <td className={`num${r.left || r.cancelled ? ' fin-dash__neg' : ''}`}>
                    {[r.left ? `−${r.left}` : '', r.cancelled ? `${r.cancelled} cancel${r.cancelled === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="fin-dash__muted">No changes in this range.</p>
      )}
    </section>
  );
}

function SourcesCard({ joined, onOpen }: { joined: BeeSubPerson[]; onOpen: (channel: string) => void }) {
  const rows = tallyBy(joined, (p) => p.source).map(([channel, count]) => {
    const paid = joined.filter((p) => p.source === channel && p.paidNow).length;
    return { key: channel, label: channel, value: count, sub: paid ? `${paid} paid` : undefined };
  });
  return (
    <section className="fin-dash__card fin-dash__card--wide">
      <DashTitle
        info={
          <p>
            Where the people who joined in this range first signed up, from Substack’s own source field. “Substack Prompts” are Substack’s subscribe and checkout buttons in emails and on posts; “Substack
            Network” is the app, Notes and recommendations. Tap a source for the people and exact sources.
          </p>
        }
      >
        Where Subscribers Come From
      </DashTitle>
      {rows.length ? <Bars rows={rows} onClick={onOpen} /> : <p className="fin-dash__muted">Nobody joined in this range.</p>}
    </section>
  );
}

function RenewalsCard({ data }: { data: BeeSubstack }) {
  const soon = data.renewals.slice(0, 8);
  return (
    <section className="fin-dash__card">
      <DashTitle info={<p>Paid plans by their next renewal or end date — always the upcoming ones, whatever range is picked.</p>}>Upcoming Renewals</DashTitle>
      {soon.length ? (
        <ul className="bee-list">
          {soon.map((r) => (
            <li key={r.email} className="bee-list__row">
              <PersonName name={r.name} email={r.email} contactId={r.contactId} />
              <span className="bee-list__meta">
                {r.plan ?? r.type} · {r.cancelled ? <span className="fin-dash__neg">Cancelled, ends </span> : 'renews '}
                {fmtDate(r.expires)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="fin-dash__muted">No paid plans with a renewal date.</p>
      )}
      {data.renewals.length > soon.length && <p className="fin-dash__note">+{data.renewals.length - soon.length} more later.</p>}
    </section>
  );
}

type SortKey = 'date' | 'openRate' | 'ratio' | 'views' | 'engagement' | 'paid';
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'date', label: 'Newest' },
  { key: 'openRate', label: 'Open Rate' },
  { key: 'ratio', label: 'Opens per Reader' },
  { key: 'views', label: 'Views' },
  { key: 'engagement', label: 'Reactions' },
  { key: 'paid', label: 'Subscribers Gained' },
];

function PostsCard({ data, posts, onOpen }: { data: BeeSubstack; posts: BeePost[]; onOpen: (p: BeePost) => void }) {
  const [sort, setSort] = useState<SortKey>('date');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(25);
  const med = data.postMedians;
  const score = (p: BeePost): number =>
    sort === 'openRate'
      ? (p.openRate ?? -1)
      : sort === 'ratio'
        ? (p.ratio ?? -1)
        : sort === 'views'
          ? p.views
          : sort === 'engagement'
            ? p.likes + p.comments + p.shares + p.restacks
            : sort === 'paid'
              ? p.signups + p.paid * 10
              : toMs(p.date);
  const list = posts
    .filter((p) => !q.trim() || p.title.toLowerCase().includes(q.trim().toLowerCase()))
    .filter((p) => sort === 'date' || sort === 'views' || sort === 'engagement' || sort === 'paid' || (p.emailed && p.delivered >= 20))
    .sort((a, b) => score(b) - score(a));
  const shown = list.slice(0, limit);
  return (
    <section className="fin-dash__card fin-dash__card--full">
      <div className="fin-dash__card-head bee-posts__head">
        <DashTitle
          info={
            <>
              <p>
                Typical post: {pct(med.openRate)} open rate, {x1(med.ratio)} opens per reader. ▲ / ▼ mark posts well above or below that; 🔁 = likely forwarded (opens per reader at least twice typical).
              </p>
              <p>Apple Mail’s automatic opens inflate every open rate, so compare posts with each other. Sorting by a rate leaves out web-only posts and sends to fewer than 20 people. Tap a post for its numbers.</p>
            </>
          }
        >
          Posts ({list.length})
        </DashTitle>
      </div>
      <div className="ally__txn-tools dash-card-tools">
        <input placeholder="Search Titles" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search post titles" />
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort posts by">
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.key === 'date' ? 'Newest' : `Best ${s.label}`}
            </option>
          ))}
        </select>
      </div>
      {list.length ? (
        <>
          <div className="fin-dash__table-wrap post-table">
            <table className="fin-dash__table bee-posts">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Title</th>
                  <th className="num">Open Rate</th>
                  <th className="num">Opens / Reader</th>
                  <th className="num">Views</th>
                  <th className="num">Reactions</th>
                  <th className="num">Gained</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.date} className="bee-social__row" onClick={() => onOpen(p)}>
                    <td className="bee-posts__date">{fmtShortDate(p.date)}</td>
                    <td className="bee-posts__title" title={p.title}>
                      {p.title}
                    </td>
                    <td className="num">{p.openRate === null ? <span className="fin-dash__muted">Web only</span> : <Delta value={p.openRate} typical={med.openRate} format={(v) => pct(v)} band={0.05} />}</td>
                    <td className="num">{p.ratio === null ? '—' : <Delta value={p.ratio} typical={med.ratio} format={x1} band={0.5} forward />}</td>
                    <td className="num">{n0(p.views)}</td>
                    <td className="num">{n0(p.likes + p.comments + p.shares + p.restacks)}</td>
                    <td className="num">{p.signups || p.paid ? `+${p.signups}${p.paid ? ` · +${p.paid} paid` : ''}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PostList posts={shown} med={med} onOpen={onOpen} phoneOnly />
        </>
      ) : (
        <p className="fin-dash__muted">No posts in this range.</p>
      )}
      {list.length > limit && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setLimit((l) => l + 50)}>
          Show More ({list.length - limit} left)
        </button>
      )}
    </section>
  );
}

/** Posts as cards — the phone layout of the posts table and the list in sheets. */
function PostList({ posts, med, onOpen, phoneOnly }: { posts: BeePost[]; med: BeeSubstack['postMedians']; onOpen: (p: BeePost) => void; phoneOnly?: boolean }) {
  if (!posts.length) return <p className="fin-dash__muted">No emails in this range.</p>;
  return (
    <ul className="post-cards" style={phoneOnly ? undefined : { display: 'block' }}>
      {posts.slice(0, 40).map((p) => (
        <li key={p.date}>
          <button type="button" className="post-card" onClick={() => onOpen(p)}>
            <div className="post-card__top">
              {fmtShortDate(p.date)}
              {!p.emailed && ' · web only'}
            </div>
            <div className="post-card__title">{p.title}</div>
            <div className="post-card__metrics">
              <span className="post-card__metric">
                <span className="post-card__metric-label">Open Rate</span>
                <span className="post-card__metric-value">{p.openRate === null ? '—' : <Delta value={p.openRate} typical={med.openRate} format={(v) => pct(v)} band={0.05} />}</span>
              </span>
              <span className="post-card__metric">
                <span className="post-card__metric-label">Per Reader</span>
                <span className="post-card__metric-value">{p.ratio === null ? '—' : <Delta value={p.ratio} typical={med.ratio} format={x1} band={0.5} forward />}</span>
              </span>
              <span className="post-card__metric">
                <span className="post-card__metric-label">Views</span>
                <span className="post-card__metric-value">{n0(p.views)}</span>
              </span>
              <span className="post-card__metric">
                <span className="post-card__metric-label">Gained</span>
                <span className="post-card__metric-value">{p.signups || p.paid ? `+${p.signups + p.paid}` : '—'}</span>
              </span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Delta({ value, typical, format, band, forward }: { value: number; typical: number | null; format: (v: number) => string; band: number; forward?: boolean }) {
  const up = typical !== null && value >= typical + band;
  const down = typical !== null && value <= typical - band;
  const big = forward && typical !== null && value >= 2 * typical;
  return (
    <span className={`bee-delta${up ? ' bee-delta--up' : ''}${down ? ' bee-delta--down' : ''}`}>
      {format(value)}
      {up ? ' ▲' : down ? ' ▼' : ''}
      {big ? ' 🔁' : ''}
    </span>
  );
}

type SpotTab = 'forwarders' | 'superfans' | 'upgrade';

function SpotlightCard({ data }: { data: BeeSubstack }) {
  const [tab, setTab] = useState<SpotTab>('forwarders');
  const [open, setOpen] = useState<BeeSpotlightPerson | null>(null);
  const s = data.spotlight;
  const list = tab === 'forwarders' ? s.forwarders : tab === 'superfans' ? s.superfans : s.upgradeCandidates;
  const tabs: { key: SpotTab; label: string; n: number }[] = [
    { key: 'forwarders', label: 'Forwarders', n: s.forwarders.length },
    { key: 'superfans', label: 'Superfans', n: s.superfans.length },
    { key: 'upgrade', label: 'Upgrade Candidates', n: s.upgradeCandidates.length },
  ];
  return (
    <section className="fin-dash__card fin-dash__card--full">
      <div className="fin-dash__card-head">
        <DashTitle
          info={
            <>
              <p>Always the last 6 months — Substack’s subscriber export only tracks engagement that far back, so this card ignores the date range.</p>
              <p>
                {tab === 'forwarders'
                  ? `Forwarders open each email well above the list’s typical ${x1(s.medianRatio)}. A forwarded email re-opens the tracking pixel for every reader it reaches. Burst = opens only some emails, many times each — likely passing favorites to a group.`
                  : tab === 'superfans'
                    ? 'Superfans: highest engagement — share of emails read, days active, clicks, shares, comments and post views.'
                    : 'Upgrade candidates: free subscribers among your superfans — the likeliest next paid members.'}
              </p>
              <p>
                {s.dormant.neverOpened} subscriber{s.dormant.neverOpened === 1 ? ' hasn’t' : 's haven’t'} opened an email in 6 months; {s.dormant.quiet30d} opened nothing in the last 30 days.
              </p>
            </>
          }
        >
          Subscriber Spotlight · 6 Months
        </DashTitle>
        <SectionPicker label="Spotlight list" value={tab} onChange={setTab} options={tabs.map((t) => [t.key, `${t.label} (${t.n})`] as const)} />
      </div>
      {list.length ? (
        <ul className="bee-list">
          {list.map((p) => (
            <li key={p.email} className="bee-list__row bee-list__row--click" role="button" tabIndex={0} onClick={() => setOpen(p)} onKeyDown={(e) => e.key === 'Enter' && setOpen(p)}>
              <span>
                <span className="bee-person">
                  {p.name || p.email}
                  {p.name && <span className="bee-person__email">{p.email}</span>}
                </span>
                <Badges p={p} />
              </span>
              <span className="bee-list__meta">
                {x1(p.ratio)} opens/email · read {p.seen6mo ?? 0}/{p.received6mo ?? 0} · score {p.score}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="fin-dash__muted">Nobody here yet.</p>
      )}
      {open && (
        <DetailSheet title={open.name || open.email} sub={open.name ? open.email : undefined} onClose={() => setOpen(null)}>
          <Badges p={open} />
          <Split
            items={[
              ['Opens / Email', x1(open.ratio), `list typical ${x1(s.medianRatio)}`],
              ['Emails Read', `${open.seen6mo ?? 0}/${open.received6mo ?? 0}`, `${open.opened6mo ?? 0} opens in all`],
              ['Score', String(open.score), 'superfan ≥ 70'],
              ['Clicks', n0(open.clicks ?? 0), ''],
              ['Shares · Comments', `${open.shares ?? 0} · ${open.comments ?? 0}`, ''],
              ['Last Open', open.lastOpen ? fmtShortDate(open.lastOpen) : '—', open.daysActive30d != null ? `${open.daysActive30d} active days (30d)` : ''],
            ]}
          />
          {open.contactId && open.contactId !== 'none' && (
            <p>
              <Link to={`/contacts/${open.contactId}`}>Open Contact Card ›</Link>
            </p>
          )}
        </DetailSheet>
      )}
    </section>
  );
}

function Badges({ p }: { p: BeeSpotlightPerson }) {
  return (
    <span className="bee-badges">
      {p.paid && <span className="bee-badge bee-badge--paid">{p.type?.replace(' Subscriber', '') ?? 'Paid'}</span>}
      {p.forwarder && <span className="bee-badge bee-badge--fwd">{p.forwarder === 'burst' ? 'Burst Forwarder' : 'Steady Forwarder'}</span>}
      {p.superfan && <span className="bee-badge">Superfan</span>}
      {p.inflated && p.forwarder && <span className="bee-badge bee-badge--muted">{p.inflated === 'work' ? 'Work Email' : 'Apple Mail'} · May Be Inflated</span>}
    </span>
  );
}

function MoneyCard({ data }: { data: BeeSubstack }) {
  const [showCharges, setShowCharges] = useState(false);
  const years = [...data.money.years].reverse();
  if (!years.length)
    return (
      <section className="fin-dash__card fin-dash__card--full">
        <h3 className="fin-dash__card-title">Paid Subscriptions &amp; Taxes</h3>
        <p className="fin-dash__muted">Add Stripe’s balance history export to the folder to see income and fees by year.</p>
      </section>
    );
  const rows: { label: string; get: (y: (typeof years)[number]) => string; strong?: boolean; neg?: boolean }[] = [
    { label: 'Charges', get: (y) => `${y.charges} (${y.newSubs} new · ${y.renewals} renewals)` },
    { label: 'Gross Subscriptions', get: (y) => money(y.gross), strong: true },
    { label: 'Substack Fee (10%)', get: (y) => money(-y.substackFee), neg: true },
    { label: 'Card Processing', get: (y) => money(-y.processing), neg: true },
    { label: 'Stripe Billing Fees', get: (y) => money(-y.billingFee), neg: true },
    ...(years.some((y) => y.refunds) ? [{ label: 'Refunds', get: (y: (typeof years)[number]) => money(-y.refunds), neg: true }] : []),
    ...(years.some((y) => y.disputes) ? [{ label: 'Disputes', get: (y: (typeof years)[number]) => money(-y.disputes), neg: true }] : []),
    { label: 'Net', get: (y) => money(y.net), strong: true },
    { label: 'Paid Out to Bank', get: (y) => money(y.paidOut) },
  ];
  return (
    <section className="fin-dash__card fin-dash__card--full">
      <DashTitle
        info={
          <p>
            By calendar year for taxes, whatever range is picked (the Net Revenue tile follows the range). Stripe combines Substack’s 10% and card processing in one fee — split here. Stripe Billing’s 0.7%
            usage fee (plus tax) posts the day after each charge. Each year also goes to that year’s Tax Packet in Vault. I’m not a tax advisor — your accountant decides how to report it.
          </p>
        }
      >
        Paid Subscriptions &amp; Taxes
      </DashTitle>
      <div className="fin-dash__table-wrap">
        <table className="fin-dash__table bee-money">
          <thead>
            <tr>
              <th />
              {years.map((y) => (
                <th key={y.year} className="num">
                  {y.year}
                  {y.year === Number(data.today.slice(0, 4)) ? ' (YTD)' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className={r.strong ? 'bee-money__strong' : undefined}>
                <td>{r.label}</td>
                {years.map((y) => (
                  <td key={y.year} className={`num${r.neg ? ' fin-dash__muted' : ''}`}>
                    {r.get(y)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fin-dash__note">{money(data.money.balance)} still in Stripe, not yet paid out.</p>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowCharges((v) => !v)}>
        {showCharges ? 'Hide Charges' : `Show All ${data.money.charges.length} Charges`}
      </button>
      {showCharges && <ChargesTable charges={data.money.charges} />}
    </section>
  );
}

function YearCard({ data }: { data: BeeSubstack }) {
  const [year, setYear] = useState<number>(data.years[0]?.year ?? Number(data.today.slice(0, 4)));
  const y: BeeYear | undefined = data.years.find((r) => r.year === year);
  if (!y) return null;
  const net = y.subsEnd - y.subsStart;
  return (
    <section className="fin-dash__card fin-dash__card--full">
      <div className="fin-dash__card-head">
        <DashTitle info={<p>A calendar year at a glance, whatever range is picked above.</p>}>Substack Year in Review</DashTitle>
        <SectionPicker label="Year" value={String(year)} onChange={(v) => setYear(Number(v))} options={data.years.map((r) => [String(r.year), `${r.year}${r.partial ? ' (So Far)' : ''}`] as const)} />
      </div>
      <div className="bee-year">
        <YearFact label="Posts" value={n0(y.posts)} sub={`${y.emailedPosts} emailed`} />
        <YearFact label="Emails Sent" value={n0(y.sent)} sub={`${n0(y.delivered)} delivered`} />
        <YearFact label="Emails Opened" value={n0(y.opened)} sub={`${pct(y.openRate)} open rate · ${n0(y.opens)} opens in all`} />
        <YearFact label="Clicks" value={n0(y.clicks)} sub={`${n0(y.views)} post views`} />
        <YearFact label="Subscribers" value={`${y.subsStart} → ${y.subsEnd}`} sub={`${net >= 0 ? '+' : ''}${net} · ${y.freeGained} joined · ${y.lost} left`} />
        <YearFact label="Paid" value={`${y.paidStart} → ${y.paidEnd}`} sub={`${y.paidGained} started paying`} />
        <YearFact label="Revenue" value={money(y.net)} sub={`${money(y.gross)} gross`} />
        <YearFact label="Reactions" value={n0(y.likes + y.comments)} sub={`${y.likes} likes · ${y.comments} comments · ${y.unsubscribes} unsubscribe${y.unsubscribes === 1 ? '' : 's'}`} />
      </div>
      <div className="bee-year__tops">
        <TopList title="Best Headlines (Open Rate)" posts={y.topByOpenRate} metric={(p) => pct(p.openRate)} />
        <TopList title="Most Forwarded (Opens per Reader)" posts={y.topByForward} metric={(p) => x1(p.ratio)} />
      </div>
    </section>
  );
}

function YearFact({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bee-year__fact">
      <span className="fin-dash__stat-label">{label}</span>
      <span className="bee-year__value">{value}</span>
      <span className="fin-dash__stat-sub">{sub}</span>
    </div>
  );
}

function TopList({ title, posts, metric }: { title: string; posts: BeeYear['topByOpenRate']; metric: (p: BeeYear['topByOpenRate'][number]) => string }) {
  return (
    <div>
      <h4 className="fin-dash__subtitle">{title}</h4>
      <ol className="bee-tops">
        {posts.map((p) => (
          <li key={p.date}>
            <span className="bee-tops__title" title={p.title}>
              {p.title}
            </span>
            <span className="bee-tops__metric">{metric(p)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function FilesCard({ data, onScan, scanning, scanMsg }: { data: BeeSubstack; onScan: () => void; scanning: boolean; scanMsg: string | null }) {
  const [all, setAll] = useState(false);
  const files = all ? data.files : data.files.slice(0, 6);
  return (
    <section className="fin-dash__card fin-dash__card--full">
      <div className="fin-dash__card-head">
        <DashTitle
          info={
            <p>
              Read nightly from the Google Drive folder. Each month add a new posts, subscriber and Stripe export (all time) named “YYYY.MM.DD - Bedford Bee - Posts/Subscribers/Stripe.csv” — never delete
              old subscriber files; comparing them is how people who leave are found.
              {data.reminder.active ? ` A reminder task appears on the ${ordinal(data.reminder.dayOfMonth)} of each month.` : ''}
            </p>
          }
        >
          Data Files
        </DashTitle>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onScan} disabled={scanning}>
          {scanning ? 'Scanning…' : 'Scan Now'}
        </button>
      </div>
      <p className="fin-dash__muted">
        {data.settings.folderUrl ? (
          <a href={data.settings.folderUrl} target="_blank" rel="noopener noreferrer">
            {data.settings.folderName ?? 'Bedford Bee'}
          </a>
        ) : (
          (data.settings.folderName ?? 'Bedford Bee')
        )}
        {data.settings.lastScanAt ? ` · checked ${new Date(data.settings.lastScanAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}
      </p>
      {scanMsg && <p className="fin-dash__note">{scanMsg}</p>}
      {data.settings.lastError && <p className="fin-dash__note fin-dash__neg">{data.settings.lastError}</p>}
      <ul className="bee-list">
        {files.map((f) => (
          <li key={f.fileId} className="bee-list__row">
            <span>
              {f.url ? (
                <a href={f.url} target="_blank" rel="noopener noreferrer">
                  {f.name}
                </a>
              ) : (
                f.name
              )}
            </span>
            <span className={`bee-list__meta${f.status === 'failed' ? ' fin-dash__neg' : ''}`}>
              {KIND_LABEL[f.kind]} · {f.status === 'parsed' ? `${f.rows ?? 0} rows · ${fmtDate(f.exportDate)}` : (f.error ?? f.status)}
            </span>
          </li>
        ))}
      </ul>
      {data.files.length > 6 && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAll((v) => !v)}>
          {all ? 'Show Fewer' : `Show All ${data.files.length} Files`}
        </button>
      )}
    </section>
  );
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BeeSearchSection } from '../components/BeeSearchSection';
import { BeeWebsiteSection } from '../components/BeeWebsiteSection';
import { BeeBingSection, BeeClaritySection } from '../components/BeeMicrosoftSections';
import { BeeSocialSection } from '../components/BeeSocialSection';
import { BeeReviewSection } from '../components/BeeReviewSection';
import { api } from '../api/client';
import type { BeePost, BeeSpotlightPerson, BeeSubstack, BeeYear } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';
import { FinanceLineChart } from '../components/FinanceLineChart';
import type { LineSeries } from '../components/FinanceLineChart';

/** Insights → Bedford Bee. Substack for now (posts, subscribers, Spotlight,
 * money, year in review) from the monthly CSV exports in the Drive
 * "Bedford Bee" folder; Search Console, GA4 and Meta get their own
 * sections here later. */

// Validated pair already used by the Finance charts (FinanceLineChart).
const TOTAL_COLOR = '#2A6FB0';
const PAID_COLOR = '#C0662E';

const toMs = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
const fmtDate = (iso: string | null) => (iso ? new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const fmtShortDate = (iso: string) => new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
const fmtMonth = (ym: string) => new Date(toMs(`${ym}-15`)).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
const fmtAxis = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
const money = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number | null, digits = 0) => (n === null ? '—' : `${(n * 100).toFixed(digits)}%`);
const x1 = (n: number | null) => (n === null ? '—' : `${n.toFixed(1)}×`);
const n0 = (n: number) => n.toLocaleString('en-US');
const KIND_LABEL: Record<string, string> = { posts: 'Posts', subscribers: 'Subscribers', stripe: 'Stripe', other: 'Not Recognized' };

type SortKey = 'date' | 'openRate' | 'ratio' | 'views' | 'engagement' | 'paid';
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'date', label: 'Newest' },
  { key: 'openRate', label: 'Open Rate' },
  { key: 'ratio', label: 'Opens per Reader' },
  { key: 'views', label: 'Views' },
  { key: 'engagement', label: 'Likes + Comments + Shares' },
  { key: 'paid', label: 'Subscribers Gained' },
];

export function BeePage() {
  useReportTabMeta('Bee', 'bee');
  const [data, setData] = useState<BeeSubstack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab = tabParam === 'search' || tabParam === 'website' || tabParam === 'substack' || tabParam === 'review' ? tabParam : 'social';

  const load = useCallback(() => {
    api
      .getBeeSubstack()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function scan() {
    setScanning(true);
    setScanMsg(null);
    try {
      const r = await api.scanBee();
      setScanMsg(r.errors.length ? r.errors.join(' · ') : r.read ? `Read ${r.read} new file${r.read === 1 ? '' : 's'}.` : 'Up to date — no new files.');
      load();
    } catch (e) {
      setScanMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="bee-page">
      <div className="links-page__header">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: '0 0 2px' }}>
          Bedford Bee
        </h1>
        <Link to="/settings?cat=bee" className="settings-gear-link" title="Bedford Bee Settings" aria-label="Bedford Bee Settings">
          ⚙️
        </Link>
      </div>
      <div className="bee-sources" role="tablist" aria-label="Source">
        {(
          [
            ['social', 'Social'],
            ['substack', 'Substack'],
            ['search', 'SEO'],
            ['website', 'Website'],
            ['review', 'Year in Review'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`btn btn--sm${tab === key ? ' is-active' : ' btn--ghost'}`}
            onClick={() => setParams(key === 'social' ? {} : { tab: key }, { replace: true })}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'social' ? (
        <BeeSocialSection />
      ) : tab === 'review' ? (
        <BeeReviewSection />
      ) : tab === 'search' ? (
        <>
          <BeeSearchSection />
          <BeeBingSection />
        </>
      ) : tab === 'website' ? (
        <>
          <BeeWebsiteSection />
          <BeeClaritySection />
        </>
      ) : (
        <>
          {error && <p className="fin-dash__muted">{error}</p>}
          {!data && !error && <p className="fin-dash__muted">Loading…</p>}
          {data && <Substack data={data} onScan={scan} scanning={scanning} scanMsg={scanMsg} />}
        </>
      )}
    </div>
  );
}

function Substack({ data, onScan, scanning, scanMsg }: { data: BeeSubstack; onScan: () => void; scanning: boolean; scanMsg: string | null }) {
  const empty = !data.files.some((f) => f.status === 'parsed');
  const thisYear = Number(data.today.slice(0, 4));
  const moneyThisYear = data.money.years.find((y) => y.year === thisYear);
  const m = data.postMedians;

  return (
    <section className="bee-section">
      <div className="bee-section__head">
        <h2 className="bee-section__title">Substack</h2>
        <span className="fin-dash__muted">
          {data.asOf.posts || data.asOf.subscribers ? `Exports from ${fmtDate([data.asOf.posts, data.asOf.subscribers, data.asOf.stripe].filter(Boolean).sort()[0] ?? null)}` : 'No exports read yet'}
          {data.reminder.active ? ` · Next export reminder on the ${ordinal(data.reminder.dayOfMonth)}` : ''}
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
          <div className="fin-dash__stats">
            <Stat label="Subscribers" value={n0(data.list.total)} sub={`+${data.list.joined30d} in the last 30 days${data.list.left ? ` · ${data.list.left} left` : ''}`} swatch={TOTAL_COLOR} />
            <Stat label="Paid" value={n0(data.list.paid)} sub={moneyThisYear ? `${money(moneyThisYear.net)} net in ${thisYear}` : `${n0(data.list.free)} free`} swatch={PAID_COLOR} />
            <Stat label="Open Rate" value={pct(m.recentOpenRate)} sub={`Last 10 emails · typical ${pct(m.openRate)}`} />
            <Stat label="Forwarders" value={n0(data.spotlight.forwarders.length)} sub={`${data.spotlight.superfans.length} superfans · ${data.spotlight.upgradeCandidates.length} upgrade candidates`} />
          </div>

          <div className="fin-dash__grid">
            <GrowthCard data={data} />
            <GainedLostCard data={data} />
            <SourcesCard data={data} />
            <RenewalsCard data={data} />
            <PostsCard data={data} />
            <SpotlightCard data={data} />
            <MoneyCard data={data} />
            <YearCard data={data} />
            <FilesCard data={data} onScan={onScan} scanning={scanning} scanMsg={scanMsg} />
          </div>
        </>
      )}
    </section>
  );
}

function Stat({ label, value, sub, swatch }: { label: string; value: string; sub?: string; swatch?: string }) {
  return (
    <div className="fin-dash__stat">
      <span className="fin-dash__stat-label">
        {swatch && <span className="bee-swatch" style={{ background: swatch }} />}
        {label}
      </span>
      <span className="fin-dash__stat-value">{value}</span>
      {sub && <span className="fin-dash__stat-sub">{sub}</span>}
    </div>
  );
}

function GrowthCard({ data }: { data: BeeSubstack }) {
  const series = useMemo<LineSeries[]>(
    () => [
      { name: 'All Subscribers', color: TOTAL_COLOR, step: true, points: data.growth.map((g) => ({ x: toMs(g.date), y: g.total })) },
      { name: 'Paid', color: PAID_COLOR, step: true, points: data.growth.map((g) => ({ x: toMs(g.date), y: g.paid })) },
    ],
    [data.growth]
  );
  return (
    <section className="fin-dash__card fin-dash__card--wide">
      <h3 className="fin-dash__card-title">Subscribers Over Time</h3>
      <FinanceLineChart series={series} formatY={(v) => n0(Math.round(v))} formatX={fmtAxis} ariaLabel="Bedford Bee subscribers and paid subscribers over time" />
      <p className="fin-dash__note">
        From each subscriber’s start and first paid dates. People who left only count from{' '}
        {data.firstSubscriberExport ? fmtDate(data.firstSubscriberExport) : 'the first export'} on — each monthly subscriber export is compared with the one before.
      </p>
    </section>
  );
}

function GainedLostCard({ data }: { data: BeeSubstack }) {
  const [all, setAll] = useState(false);
  const rows = all ? data.months : data.months.slice(0, 12);
  return (
    <section className="fin-dash__card">
      <h3 className="fin-dash__card-title">Gained &amp; Lost</h3>
      <div className="fin-dash__table-wrap">
        <table className="fin-dash__table bee-table--compact">
          <thead>
            <tr>
              <th>Month</th>
              <th className="num">Free</th>
              <th className="num">Paid</th>
              <th className="num" title="Free subscribers who started paying">Upgrades</th>
              <th className="num">Left</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.month}>
                <td>{fmtMonth(r.month)}</td>
                <td className="num">{r.freeJoined ? `+${r.freeJoined}` : '—'}</td>
                <td className="num">{r.paidJoined ? `+${r.paidJoined}` : '—'}</td>
                <td className="num">{r.upgrades ? `+${r.upgrades}` : '—'}</td>
                <td className={`num${r.left || r.cancelled ? ' fin-dash__neg' : ''}`} title={r.cancelled ? `${r.cancelled} paid plan${r.cancelled === 1 ? '' : 's'} cancelled` : undefined}>
                  {[r.left ? `−${r.left}` : '', r.cancelled ? `${r.cancelled} cancel${r.cancelled === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.months.length > 12 && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAll((v) => !v)}>
          {all ? 'Show Last 12 Months' : `Show All ${data.months.length} Months`}
        </button>
      )}
    </section>
  );
}

function SourcesCard({ data }: { data: BeeSubstack }) {
  const [open, setOpen] = useState<string | null>(null);
  const max = Math.max(1, ...data.sources.free.map((s) => s.count));
  return (
    <section className="fin-dash__card fin-dash__card--wide">
      <h3 className="fin-dash__card-title">Where Subscribers Come From</h3>
      <div className="bee-bars">
        {data.sources.free.map((s) => (
          <div key={s.channel} className="bee-bars__group">
            <button type="button" className="bee-bars__row" onClick={() => setOpen(open === s.channel ? null : s.channel)} aria-expanded={open === s.channel}>
              <span className="bee-bars__label">{s.channel}</span>
              <span className="bee-bars__track">
                <span className="bee-bars__bar" style={{ width: `${(s.count / max) * 100}%` }} />
              </span>
              <span className="bee-bars__value">
                {s.count}
                {s.paid ? <span className="bee-bars__paid"> · {s.paid} paid</span> : null}
              </span>
            </button>
            {open === s.channel && (
              <div className="bee-bars__raw">
                {s.raw.map((r) => (
                  <span key={r.source}>
                    {r.source} <b>{r.count}</b>
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {data.sources.paid.length > 0 && (
        <p className="fin-dash__note">
          Paid sign-ups came from: {data.sources.paid.map((s) => `${s.channel} ${s.count}`).join(' · ')}. “Substack Prompts” are Substack’s own subscribe and checkout buttons in emails and on posts.
        </p>
      )}
    </section>
  );
}

function RenewalsCard({ data }: { data: BeeSubstack }) {
  const soon = data.renewals.slice(0, 8);
  return (
    <section className="fin-dash__card">
      <h3 className="fin-dash__card-title">Upcoming Renewals</h3>
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

function PostsCard({ data }: { data: BeeSubstack }) {
  const [sort, setSort] = useState<SortKey>('date');
  const [year, setYear] = useState<string>('all');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(25);
  const med = data.postMedians;
  const years = [...new Set(data.posts.map((p) => p.date.slice(0, 4)))].sort().reverse();
  const score = (p: BeePost): number =>
    sort === 'openRate' ? p.openRate ?? -1 : sort === 'ratio' ? p.ratio ?? -1 : sort === 'views' ? p.views : sort === 'engagement' ? p.likes + p.comments + p.shares + p.restacks : sort === 'paid' ? p.signups + p.paid * 10 : toMs(p.date);
  const list = data.posts
    .filter((p) => (year === 'all' || p.date.startsWith(year)) && (!q.trim() || p.title.toLowerCase().includes(q.trim().toLowerCase())))
    .filter((p) => sort === 'date' || sort === 'views' || sort === 'engagement' || (p.emailed && p.delivered >= 20))
    .sort((a, b) => score(b) - score(a));
  const shown = list.slice(0, limit);

  return (
    <section className="fin-dash__card fin-dash__card--full">
      <div className="fin-dash__card-head bee-posts__head">
        <h3 className="fin-dash__card-title">Posts</h3>
        <div className="ally__txn-tools bee-posts__controls">
          <input placeholder="Search Titles" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search post titles" />
          <select value={year} onChange={(e) => setYear(e.target.value)} aria-label="Year">
            <option value="all">All Years</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort posts by">
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                Sort: {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="fin-dash__table-wrap">
        <table className="fin-dash__table bee-posts">
          <thead>
            <tr>
              <th>Date</th>
              <th>Title</th>
              <th className="num" title="Unique openers ÷ delivered — how well the headline/subject line worked">
                Open Rate
              </th>
              <th className="num" title="Total opens ÷ unique openers — high means it was forwarded">
                Opens / Reader
              </th>
              <th className="num bee-hide-sm">Sent</th>
              <th className="num bee-hide-sm">Views</th>
              <th className="num bee-hide-sm" title="Likes · comments · shares">
                Reactions
              </th>
              <th className="num bee-hide-sm" title="Free sign-ups · paid subscriptions from this post">
                Gained
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.date}>
                <td className="bee-posts__date">{fmtShortDate(p.date)}</td>
                <td className="bee-posts__title" title={p.title}>
                  {p.title}
                </td>
                <td className="num">
                  {p.openRate === null ? <span className="fin-dash__muted">Web only</span> : <Delta value={p.openRate} typical={med.openRate} format={(v) => pct(v)} band={0.05} />}
                </td>
                <td className="num">{p.ratio === null ? '—' : <Delta value={p.ratio} typical={med.ratio} format={x1} band={0.5} forward />}</td>
                <td className="num bee-hide-sm">{p.emailed ? n0(p.sent) : '—'}</td>
                <td className="num bee-hide-sm">{n0(p.views)}</td>
                <td className="num bee-hide-sm">
                  {p.likes} · {p.comments} · {p.shares + p.restacks}
                </td>
                <td className="num bee-hide-sm">
                  {p.signups || p.paid ? (
                    <>
                      {p.signups ? `+${p.signups} free` : ''}
                      {p.signups && p.paid ? ' · ' : ''}
                      {p.paid ? <b>+{p.paid} paid</b> : ''}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length > limit && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setLimit((l) => l + 50)}>
          Show More ({list.length - limit} left)
        </button>
      )}
      <p className="fin-dash__note">
        Typical post: {pct(med.openRate)} open rate, {x1(med.ratio)} opens per reader. ▲ / ▼ mark posts well above or below that. Apple Mail’s automatic opens inflate every open rate, so compare posts with each
        other rather than reading it as an exact count. Sorting by a rate leaves out web-only posts and sends to fewer than 20 people.
      </p>
    </section>
  );
}

function Delta({ value, typical, format, band, forward }: { value: number; typical: number | null; format: (v: number) => string; band: number; forward?: boolean }) {
  const up = typical !== null && value >= typical + band;
  const down = typical !== null && value <= typical - band;
  const big = forward && typical !== null && value >= 2 * typical;
  return (
    <span className={`bee-delta${up ? ' bee-delta--up' : ''}${down ? ' bee-delta--down' : ''}`} title={big ? 'Likely forwarded — opens per reader at least twice the typical post' : undefined}>
      {format(value)}
      {up ? ' ▲' : down ? ' ▼' : ''}
      {big ? ' 🔁' : ''}
    </span>
  );
}

type SpotTab = 'forwarders' | 'superfans' | 'upgrade';

function SpotlightCard({ data }: { data: BeeSubstack }) {
  const [tab, setTab] = useState<SpotTab>('forwarders');
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
        <h3 className="fin-dash__card-title">Subscriber Spotlight</h3>
        <div className="ally__range bee-tabs" role="tablist" aria-label="Spotlight list">
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`btn btn--sm${tab === t.key ? ' is-active' : ' btn--ghost'}`} onClick={() => setTab(t.key)}>
              {t.label} ({t.n})
            </button>
          ))}
        </div>
      </div>
      <p className="fin-dash__muted bee-spot__explain">
        {tab === 'forwarders'
          ? `Opens per email well above the list’s typical ${x1(s.medianRatio)} (last 6 months). A forwarded email re-opens the tracking pixel for every reader it reaches. Burst = opens only some emails, many times each — likely passing favorites to a group.`
          : tab === 'superfans'
            ? 'Highest engagement: share of emails read, days active, clicks, shares, comments and post views.'
            : 'Free subscribers among your superfans — the likeliest next paid members.'}
      </p>
      {list.length ? (
        <div className="fin-dash__table-wrap">
          <table className="fin-dash__table bee-spot">
            <thead>
              <tr>
                <th>Subscriber</th>
                <th className="num">Opens / Email</th>
                <th className="num">Emails Read</th>
                <th className="num bee-hide-sm">Score</th>
                <th className="num bee-hide-sm">Clicks</th>
                <th className="num bee-hide-sm">Shares · Comments</th>
                <th className="bee-hide-sm">Last Open</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <SpotRow key={p.email} p={p} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="fin-dash__muted">Nobody here yet.</p>
      )}
      <p className="fin-dash__note">
        {s.dormant.neverOpened} subscriber{s.dormant.neverOpened === 1 ? ' hasn’t' : 's haven’t'} opened an email in 6 months; {s.dormant.quiet30d} opened nothing in the last 30 days. Each name opens their contact card.
      </p>
    </section>
  );
}

function SpotRow({ p }: { p: BeeSpotlightPerson }) {
  return (
    <tr>
      <td>
        <PersonName name={p.name} email={p.email} contactId={p.contactId} />
        <span className="bee-badges">
          {p.paid && <span className="bee-badge bee-badge--paid">{p.type?.replace(' Subscriber', '') ?? 'Paid'}</span>}
          {p.forwarder && <span className="bee-badge bee-badge--fwd">{p.forwarder === 'burst' ? 'Burst Forwarder' : 'Steady Forwarder'}</span>}
          {p.superfan && <span className="bee-badge">Superfan</span>}
          {p.inflated && p.forwarder && (
            <span className="bee-badge bee-badge--muted" title={p.inflated === 'work' ? 'Work email — a security scanner can add opens' : 'Apple Mail — automatic opens and several devices can add opens'}>
              {p.inflated === 'work' ? 'Work Email' : 'Apple Mail'} · May Be Inflated
            </span>
          )}
        </span>
      </td>
      <td className="num">{x1(p.ratio)}</td>
      <td className="num" title={`${p.seen6mo ?? 0} of ${p.received6mo ?? 0} emails opened, ${p.opened6mo ?? 0} opens in all`}>
        {p.seen6mo ?? 0}/{p.received6mo ?? 0}
      </td>
      <td className="num bee-hide-sm">{p.score}</td>
      <td className="num bee-hide-sm">{p.clicks ?? 0}</td>
      <td className="num bee-hide-sm">
        {p.shares ?? 0} · {p.comments ?? 0}
      </td>
      <td className="bee-hide-sm">{p.lastOpen ? fmtShortDate(p.lastOpen) : '—'}</td>
    </tr>
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
  const rows: { label: string; get: (y: (typeof years)[number]) => string; strong?: boolean; neg?: boolean; hideZero?: boolean }[] = [
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
      <h3 className="fin-dash__card-title">Paid Subscriptions &amp; Taxes</h3>
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
      <p className="fin-dash__note">
        {money(data.money.balance)} still in Stripe, not yet paid out. Stripe combines Substack’s 10% and card processing in one fee — split here. Stripe Billing’s 0.7% usage fee (plus tax) posts the day after each
        charge. Each year’s numbers also go to that year’s Tax Packet in Vault. I’m not a tax advisor — your accountant decides how to report it.
      </p>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowCharges((v) => !v)}>
        {showCharges ? 'Hide Charges' : `Show All ${data.money.charges.length} Charges`}
      </button>
      {showCharges && (
        <div className="fin-dash__table-wrap">
          <table className="fin-dash__table bee-table--compact">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th className="num">Amount</th>
                <th className="num">Fee</th>
                <th className="num">Net</th>
                <th className="bee-hide-sm">Paid Out</th>
              </tr>
            </thead>
            <tbody>
              {data.money.charges.map((c) => (
                <tr key={c.id}>
                  <td>{fmtDate(c.date)}</td>
                  <td>{/creation/i.test(c.description ?? '') ? 'New' : /update/i.test(c.description ?? '') ? 'Renewal / Change' : c.description ?? c.type}</td>
                  <td className="num">{money(c.amount)}</td>
                  <td className="num fin-dash__muted">{money(-c.fee)}</td>
                  <td className="num">{money(c.net)}</td>
                  <td className="bee-hide-sm">{c.payoutDate ? fmtDate(c.payoutDate) : 'In Stripe'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
        <h3 className="fin-dash__card-title">Year in Review</h3>
        <div className="ally__range bee-tabs" role="tablist" aria-label="Year">
          {data.years.map((r) => (
            <button key={r.year} type="button" role="tab" aria-selected={year === r.year} className={`btn btn--sm${year === r.year ? ' is-active' : ' btn--ghost'}`} onClick={() => setYear(r.year)}>
              {r.year}
              {r.partial ? ' (So Far)' : ''}
            </button>
          ))}
        </div>
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
        <h3 className="fin-dash__card-title">Data Files</h3>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onScan} disabled={scanning}>
          {scanning ? 'Scanning…' : 'Scan Now'}
        </button>
      </div>
      <p className="fin-dash__muted">
        Read from{' '}
        {data.settings.folderUrl ? (
          <a href={data.settings.folderUrl} target="_blank" rel="noopener noreferrer">
            {data.settings.folderName ?? 'Bedford Bee'}
          </a>
        ) : (
          data.settings.folderName ?? 'Bedford Bee'
        )}{' '}
        in Google Drive{data.settings.lastScanAt ? ` · last checked ${new Date(data.settings.lastScanAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''} · nightly. Each month add a
        new posts, subscriber and Stripe export (all time) named “YYYY.MM.DD - Bedford Bee - Posts/Subscribers/Stripe.csv” — never delete old subscriber files; comparing them is how people who leave are found.
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
              {KIND_LABEL[f.kind]} · {f.status === 'parsed' ? `${f.rows ?? 0} rows · ${fmtDate(f.exportDate)}` : f.error ?? f.status}
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

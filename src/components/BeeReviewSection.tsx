import { useEffect, useMemo, useState } from 'react';
import { SectionPicker } from './dash/SectionPicker';
import { DashTitle } from './dash/InfoTip';
import { api } from '../api/client';
import type { BeeReview, BeeReviewTop, BeeReviewTotals } from '../api/types';
import { FinanceLineChart } from './FinanceLineChart';
import type { LineSeries } from './FinanceLineChart';

/** Bedford Bee → Year in Review: every source in one place, the year so far
 * vs last year (same dates, or the whole year). worker/src/bee/review.ts. */

const n0 = (n: number | null | undefined) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
const big = (n: number | null | undefined) => {
  if (n == null) return '—';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${Math.round(n / 1000)}K`;
  return n0(n);
};
const money = (n: number | null | undefined) => (n == null ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`);
const fmtDate = (d: string) =>
  new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
const fmtAxis = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
const PLAT: Record<string, string> = {
  fb: 'Facebook',
  ig: 'Instagram',
  substack: 'Substack',
};

type Compare = 'same' | 'full' | 'avg';

/** Active months in a range (from the Bee's start when later), for monthly averages. */
const monthsIn = (from: string, to: string, started: string | null) => {
  const a = new Date(`${started && started > from ? started : from}T12:00:00Z`).getTime();
  const b = new Date(`${to}T12:00:00Z`).getTime();
  return Math.max(0.5, (b - a) / 86400000 / 30.44);
};

export function BeeReviewSection() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [data, setData] = useState<BeeReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compare, setCompare] = useState<Compare>('avg');
  useEffect(() => {
    setData(null);
    api
      .getBeeReview(year)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [year]);
  if (error) return <p className="fin-dash__muted">{error}</p>;
  if (!data) return <p className="fin-dash__muted">Loading…</p>;
  const prevT = compare === 'same' ? data.prevSameTotals : data.prevFull;
  // Monthly average: both years' totals ÷ the months the Bee was active.
  const mNow = monthsIn(data.now.range.from, data.now.range.to, data.started);
  const mPrev = monthsIn(data.prevFull.range.from, data.prevFull.range.to, data.started);
  const scale = compare === 'avg' ? { now: 1 / mNow, prev: 1 / mPrev } : { now: 1, prev: 1 };
  return (
    <section className="bee-section">
      <div className="bee-section__head">
        <h2 className="bee-section__title">
          {data.year} in Review{data.partial ? ' (So Far)' : ''}
        </h2>
        <span className="fin-dash__muted">
          Jan 1 – {fmtDate(data.now.range.to)}
          {data.started && data.started > `${data.year - 1}-01-01` ? ` · the Bee started ${fmtDate(data.started)}` : ''}
        </span>
        <div className="ally__range bee-tabs bee-social__plat" role="tablist" aria-label="Year">
          {[thisYear, thisYear - 1].map((y) => (
            <button key={y} type="button" role="tab" aria-selected={year === y} className={`btn btn--sm${year === y ? ' is-active' : ' btn--ghost'}`} onClick={() => setYear(y)}>
              {y}
            </button>
          ))}
        </div>
      </div>
      <div className="bee-review__compare">
        <span className="fin-dash__muted">Compare to:</span>
        {(
          [
            ['avg', 'Monthly average'],
            ['same', `${data.year - 1}, same dates`],
            ['full', `${data.year - 1}, whole year`],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" className={`btn btn--sm${compare === k ? ' is-active' : ' btn--ghost'}`} onClick={() => setCompare(k)}>
            {label}
          </button>
        ))}
        <CopyStats data={data} />
      </div>
      {compare === 'avg' && (
        <p className="fin-dash__muted bee-review__avgnote">
          Per month: {data.year} so far ({mNow.toFixed(1)} months) vs {data.year - 1} ({mPrev.toFixed(1)} months
          {data.started && data.started > data.prevFull.range.from ? `, from launch on ${fmtDate(data.started)}` : ''}
          ).
        </p>
      )}
      <Headline data={data} prev={prevT} compare={compare} scale={scale} />
      <div className="fin-dash__grid">
        <Tops data={data} />
        <MonthsCard data={data} />
        <PlatformTable data={data} prev={prevT} compare={compare} scale={scale} />
      </div>
    </section>
  );
}

function delta(now: number | null | undefined, prev: number | null | undefined): { text: string; tone: '' | 'up' | 'down' } {
  if (now == null || prev == null) return { text: '', tone: '' };
  if (!prev) return now ? { text: 'new this year', tone: 'up' } : { text: '', tone: '' };
  const d = (now - prev) / prev;
  if (Math.abs(d) < 0.03) return { text: 'about the same', tone: '' };
  return {
    text: `${d > 0 ? '+' : '−'}${Math.abs(d * 100) >= 1000 ? `${Math.round(d)}×` : `${Math.abs(d * 100).toFixed(0)}%`}`,
    tone: d > 0 ? 'up' : 'down',
  };
}

function Tile({
  label,
  value,
  prev,
  prevLabel,
  raw,
  prevRaw,
  fmt = big,
}: {
  label: string;
  value: string;
  prev?: string;
  prevLabel: string;
  raw?: number | null;
  prevRaw?: number | null;
  fmt?: (n: number | null | undefined) => string;
}) {
  const d = delta(raw, prevRaw);
  return (
    <div className="bee-review__tile">
      <span className="fin-dash__stat-label">{label}</span>
      <span className="bee-review__value">{value}</span>
      <span className="fin-dash__stat-sub">
        {d.text && <span className={d.tone === 'up' ? 'bee-delta--up' : d.tone === 'down' ? 'bee-delta--down' : ''}>{d.text} </span>}
        {prev !== undefined ? (prevLabel ? `${prevLabel}: ${prev}` : prev) : prevRaw != null ? `${prevLabel}: ${fmt(prevRaw)}` : ''}
      </span>
    </div>
  );
}

function Headline({ data, prev, compare, scale }: { data: BeeReview; prev: BeeReviewTotals; compare: Compare; scale: { now: number; prev: number } }) {
  const n = data.now;
  const pl = compare === 'same' ? `${data.year - 1} same dates` : compare === 'avg' ? `${data.year - 1} per month` : `${data.year - 1}`;
  const avg = compare === 'avg';
  const sv = (x: number) => x * scale.now;
  const pv = (x: number) => x * scale.prev;
  const per = avg ? ' / Month' : '';
  const gaMissing = !!data.sources.ga && data.sources.ga > prev.range.to;
  const gscMissing = !!data.sources.gsc && data.sources.gsc > prev.range.to;
  const sub = data.substack.now;
  const subPrev = data.substack.prev;
  return (
    <div className="bee-review__grid">
      <Tile label={`Total Views${per}`} value={big(sv(n.everything.views))} raw={sv(n.everything.views)} prevRaw={pv(prev.everything.views)} prevLabel={pl} />
      <Tile
        label={`Stories Published${per}`}
        value={avg ? sv(n.stories).toFixed(1) : n0(n.stories)}
        raw={sv(n.stories)}
        prevRaw={pv(prev.stories)}
        prevLabel={pl}
        fmt={(x) => (avg ? (x ?? 0).toFixed(1) : n0(x))}
      />
      <Tile label={`Likes${per}`} value={big(sv(n.everything.likes))} raw={sv(n.everything.likes)} prevRaw={pv(prev.everything.likes)} prevLabel={pl} />
      <Tile label={`Comments${per}`} value={big(sv(n.everything.comments))} raw={sv(n.everything.comments)} prevRaw={pv(prev.everything.comments)} prevLabel={pl} />
      <Tile label={`Shares${per}`} value={big(sv(n.everything.shares))} raw={sv(n.everything.shares)} prevRaw={pv(prev.everything.shares)} prevLabel={pl} />
      <Tile label="Facebook Followers" value={n0(data.followers.facebook)} raw={n.facebook.followersEnd} prevRaw={n.facebook.followersStart} prevLabel={`Jan 1`} fmt={n0} />
      <Tile label="Instagram Followers" value={n0(data.followers.instagram)} prevLabel="" prev="history starts now (Instagram keeps 30 days)" />
      <Tile label="Substack Subscribers" value={n0(sub?.subsEnd)} raw={sub?.subsEnd} prevRaw={sub?.subsStart} prevLabel="Jan 1" fmt={n0} />
      <Tile label="Paid Subscribers" value={n0(sub?.paidEnd)} raw={sub?.paidEnd} prevRaw={sub?.paidStart} prevLabel="Jan 1" fmt={n0} />
      <Tile
        label="Gross Revenue"
        value={money(sub?.gross)}
        raw={compare !== 'same' ? sub?.gross : undefined}
        prevRaw={compare !== 'same' ? subPrev?.gross : undefined}
        prevLabel={`${data.year - 1}`}
        fmt={money}
        prev={compare === 'same' ? `net ${money(sub?.net)} after fees` : undefined}
      />
      {(n.merch?.orders ?? 0) > 0 && (
        <Tile label={`Merch Sales${per}`} value={money(sv(n.merch?.sales ?? 0))} raw={sv(n.merch?.sales ?? 0)} prevRaw={pv(prev.merch?.sales ?? 0)} prevLabel={pl} fmt={money} />
      )}
      <Tile label={`Emails Sent${per}`} value={big(sv(n.substack.emailsSent))} raw={sv(n.substack.emailsSent)} prevRaw={pv(prev.substack.emailsSent)} prevLabel={pl} />
      <Tile
        label="Website Visits"
        value={big(n.website.visits)}
        raw={gaMissing ? undefined : n.website.visits}
        prevRaw={gaMissing ? undefined : prev.website.visits}
        prevLabel={gaMissing ? '' : pl}
        prev={gaMissing && data.sources.ga ? `tracking began ${fmtDate(data.sources.ga)}` : undefined}
      />
      <Tile label="Website Visitors" value={n0(data.visitors.thisYear)} prevLabel="" prev={data.visitors.lastYear ? `${data.year - 1}: ${n0(data.visitors.lastYear)}` : 'unique people'} />
      <Tile
        label="Google Search Clicks"
        value={big(n.search.googleClicks)}
        raw={gscMissing ? undefined : n.search.googleClicks}
        prevRaw={gscMissing ? undefined : prev.search.googleClicks}
        prevLabel={gscMissing ? '' : pl}
        prev={gscMissing && data.sources.gsc ? `data since ${fmtDate(data.sources.gsc)}` : undefined}
      />
    </div>
  );
}

const pickTop = (t: BeeReviewTop, k: 'views' | 'likes' | 'comments' | 'shares', plat: string) => (plat === 'combined' ? t.total[k] : (t.parts.find((p) => p.platform === plat)?.[k] ?? 0));

function Tops({ data }: { data: BeeReview }) {
  const [plat, setPlat] = useState<'combined' | 'facebook' | 'instagram' | 'substack'>('combined');
  const set = data.tops[plat];
  const code = plat === 'facebook' ? 'fb' : plat === 'instagram' ? 'ig' : plat;
  const blocks: {
    k: 'views' | 'likes' | 'comments' | 'shares';
    title: string;
  }[] = [
    { k: 'views', title: 'Most Viewed' },
    { k: 'likes', title: 'Most Liked' },
    { k: 'shares', title: 'Most Shared' },
    { k: 'comments', title: 'Most Commented' },
  ];
  return (
    <section className="fin-dash__card fin-dash__card--full">
      <div className="fin-dash__card-head">
        <DashTitle info={<p>Hover a story to see each platform’s number. “All Platforms” adds Facebook, Instagram and Substack for the same story.</p>}>Top Stories of {data.year}</DashTitle>
        <SectionPicker
          label="Platform"
          value={plat}
          onChange={setPlat}
          options={[
            ['combined', 'All Platforms'],
            ['facebook', 'Facebook'],
            ['instagram', 'Instagram'],
            ['substack', 'Substack'],
          ]}
        />
      </div>
      <div className="bee-review__tops">
        {blocks.map((b) => (
          <div key={b.k}>
            <h4 className="fin-dash__subtitle">{b.title}</h4>
            <ol className="bee-tops">
              {set[b.k].map((t) => (
                <li key={`${t.date}-${t.headline}`} title={t.parts.map((p) => `${PLAT[p.platform]}: ${n0(p[b.k])}`).join(' · ')}>
                  <span className="bee-tops__title">{t.headline}</span>
                  <span className="bee-tops__metric">{big(pickTop(t, b.k, code))}</span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </section>
  );
}

function MonthsCard({ data }: { data: BeeReview }) {
  const series = useMemo<LineSeries[]>(() => {
    const toMs = (m: string) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 15).getTime();
    return [
      {
        name: 'Social (FB + IG)',
        color: '#2A6FB0',
        points: data.months.map((m) => ({ x: toMs(m.month), y: m.social })),
      },
      {
        name: 'Substack + Website',
        color: '#C0662E',
        points: data.months.map((m) => ({
          x: toMs(m.month),
          y: m.substack + m.website,
        })),
      },
    ];
  }, [data.months]);
  return (
    <section className="fin-dash__card fin-dash__card--full">
      <DashTitle info={<p>Social = Facebook + Instagram views of posts published that month. Substack = views of that month’s posts (email opens + web); website = Google Analytics page views.</p>}>
        Views by Month
      </DashTitle>
      <FinanceLineChart series={series} formatY={big} formatX={fmtAxis} ariaLabel="Bedford Bee views per month, social vs Substack and website" />
    </section>
  );
}

function PlatformTable({ data, prev, compare, scale }: { data: BeeReview; prev: BeeReviewTotals; compare: Compare; scale: { now: number; prev: number } }) {
  const n = data.now;
  const gaMissing = !!data.sources.ga && data.sources.ga > prev.range.to;
  const gscMissing = !!data.sources.gsc && data.sources.gsc > prev.range.to;
  const bingMissing = !n.search.bingClicks && !prev.search.bingClicks;
  const rawRows: {
    label: string;
    now: number | null;
    prev: number | null;
    fmt?: (x: number | null | undefined) => string;
    flat?: boolean;
  }[] = [
    {
      label: 'Facebook posts',
      now: n.facebook.posts,
      prev: prev.facebook.posts,
    },
    {
      label: 'Facebook views',
      now: n.facebook.views,
      prev: prev.facebook.views,
    },
    {
      label: 'Facebook likes / reactions',
      now: n.facebook.likes,
      prev: prev.facebook.likes,
    },
    {
      label: 'Facebook comments',
      now: n.facebook.comments,
      prev: prev.facebook.comments,
    },
    {
      label: 'Facebook shares',
      now: n.facebook.shares,
      prev: prev.facebook.shares,
    },
    {
      label: 'Instagram posts',
      now: n.instagram.posts,
      prev: prev.instagram.posts,
    },
    {
      label: 'Instagram views',
      now: n.instagram.views,
      prev: prev.instagram.views,
    },
    {
      label: 'Instagram likes',
      now: n.instagram.likes,
      prev: prev.instagram.likes,
    },
    {
      label: 'Instagram comments',
      now: n.instagram.comments,
      prev: prev.instagram.comments,
    },
    {
      label: 'Instagram shares',
      now: n.instagram.shares,
      prev: prev.instagram.shares,
    },
    {
      label: 'Instagram saves',
      now: n.instagram.saves,
      prev: prev.instagram.saves,
    },
    {
      label: 'Substack posts',
      now: n.substack.posts,
      prev: prev.substack.posts,
    },
    {
      label: 'Substack emails sent',
      now: n.substack.emailsSent,
      prev: prev.substack.emailsSent,
    },
    {
      label: 'Substack emails opened',
      now: n.substack.opened,
      prev: prev.substack.opened,
    },
    {
      label: 'Substack views',
      now: n.substack.views,
      prev: prev.substack.views,
    },
    {
      label: 'New Substack subscribers',
      now: data.substack.now?.joined ?? null,
      prev: compare !== 'same' ? (data.substack.prev?.joined ?? null) : null,
    },
    {
      label: 'New paid subscribers',
      now: data.substack.now?.paidGained ?? null,
      prev: compare !== 'same' ? (data.substack.prev?.paidGained ?? null) : null,
    },
    {
      label: 'Net revenue',
      now: data.substack.now?.net ?? null,
      prev: compare !== 'same' ? (data.substack.prev?.net ?? null) : null,
      fmt: money,
    },
    {
      label: 'Merch orders',
      now: n.merch?.orders ?? 0,
      prev: prev.merch?.orders ?? 0,
    },
    {
      label: 'Merch sales',
      now: n.merch?.sales ?? 0,
      prev: prev.merch?.sales ?? 0,
      fmt: money,
    },
    {
      label: 'Website visits',
      now: n.website.visits,
      prev: gaMissing ? null : prev.website.visits,
    },
    {
      label: 'Website page views',
      now: n.website.pageViews,
      prev: gaMissing ? null : prev.website.pageViews,
    },
    {
      label: 'Google search clicks',
      now: n.search.googleClicks,
      prev: gscMissing ? null : prev.search.googleClicks,
    },
    {
      label: 'Google search impressions',
      now: n.search.googleImpressions,
      prev: gscMissing ? null : prev.search.googleImpressions,
    },
    ...(bingMissing
      ? []
      : [
          {
            label: 'Bing search clicks',
            now: n.search.bingClicks,
            prev: prev.search.bingClicks,
          },
        ]),
  ];
  // Monthly average: per-month values; sources that started mid-year are averaged over their own months.
  const gaMonths = data.sources.ga ? monthsIn(data.now.range.from, data.now.range.to, data.sources.ga) : 1;
  const gscMonths = data.sources.gsc ? monthsIn(data.now.range.from, data.now.range.to, data.sources.gsc) : 1;
  const rows = rawRows.map((r) => {
    if (compare !== 'avg') return r;
    const nowScale = /^Website/.test(r.label) ? 1 / gaMonths : /^Google/.test(r.label) ? 1 / gscMonths : scale.now;
    return {
      ...r,
      now: r.now == null ? null : r.now * nowScale,
      prev: r.prev == null ? null : r.prev * scale.prev,
    };
  });
  return (
    <section className="fin-dash__card fin-dash__card--full">
      <DashTitle
        info={
          <p>
            Numbers count posts published in each period. Some sources start later than the Bee: Google Analytics from {data.sources.ga ? fmtDate(data.sources.ga) : '—'}, Search Console from{' '}
            {data.sources.gsc ? fmtDate(data.sources.gsc) : '—'}, so earlier periods show less for them. Subscriber and revenue changes compare against {data.year - 1} only for the whole year.
          </p>
        }
      >
        Every Number
      </DashTitle>
      <div className="fin-dash__table-wrap">
        <table className="fin-dash__table bee-table--compact">
          <thead>
            <tr>
              <th />
              <th className="num">
                {data.year}
                {compare === 'avg' ? ' per month' : data.partial ? ' (so far)' : ''}
              </th>
              <th className="num">{compare === 'same' ? `${data.year - 1} same dates` : compare === 'avg' ? `${data.year - 1} per month` : data.year - 1}</th>
              <th className="num">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const d = delta(r.now, r.prev);
              const f = r.fmt ?? (compare === 'avg' ? (x: number | null | undefined) => (x == null ? '—' : x < 20 ? x.toFixed(1) : n0(x)) : n0);
              return (
                <tr key={r.label}>
                  <td>{r.label}</td>
                  <td className="num">{f(r.now)}</td>
                  <td className="num fin-dash__muted">{r.prev == null ? '—' : f(r.prev)}</td>
                  <td className={`num${d.tone === 'up' ? ' bee-delta--up' : d.tone === 'down' ? ' bee-delta--down' : ''}`}>{d.text || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CopyStats({ data }: { data: BeeReview }) {
  const [copied, setCopied] = useState(false);
  const n = data.now;
  const top = data.tops.combined;
  const text = [
    `🐝 The Bedford Bee — ${data.year}${data.partial ? ' so far' : ''} by the numbers`,
    ``,
    `📰 ${n0(n.stories)} stories published`,
    `👀 ${n0(n.everything.views)} views across Facebook, Instagram, Substack and the website`,
    `❤️ ${n0(n.everything.likes)} likes · 💬 ${n0(n.everything.comments)} comments · 🔁 ${n0(n.everything.shares)} shares`,
    data.followers.facebook != null || data.followers.instagram != null
      ? `👥 ${n0((data.followers.facebook ?? 0) + (data.followers.instagram ?? 0))} followers on Facebook and Instagram${data.substack.now ? ` · ✉️ ${n0(data.substack.now.subsEnd)} Substack subscribers` : ''}`
      : '',
    n.website.visits ? `🌐 ${n0(n.website.visits)} visits to thebedfordbee.com` : '',
    ``,
    top.views[0] ? `🏆 Most viewed: “${top.views[0].headline}” (${n0(top.views[0].total.views)} views)` : '',
    top.shares[0] ? `🔁 Most shared: “${top.shares[0].headline}” (${n0(top.shares[0].total.shares)} shares)` : '',
    top.comments[0] ? `💬 Most talked about: “${top.comments[0].headline}” (${n0(top.comments[0].total.comments)} comments)` : '',
    top.likes[0] ? `❤️ Most liked: “${top.likes[0].headline}” (${n0(top.likes[0].total.likes)} likes)` : '',
    ``,
    `Thank you for reading. 🐝`,
  ]
    .filter((l, i, a) => l !== '' || (a[i - 1] !== '' && i > 0))
    .join('\n');
  const [show, setShow] = useState(false);
  return (
    <>
      <button
        type="button"
        className="btn btn--sm bee-review__copy"
        onClick={async () => {
          setShow(true);
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2500);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? 'Copied ✓' : 'Copy Stats for Followers'}
      </button>
      {show && <textarea className="bee-rules bee-review__text" readOnly rows={14} value={text} onFocus={(e) => e.currentTarget.select()} />}
    </>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { BeeMetric, BeeSocial, BeeSocialPost } from '../api/types';
import { FinanceLineChart } from './FinanceLineChart';
import type { LineSeries } from './FinanceLineChart';
import { apiError } from './BeeMicrosoftSections';
import { BeeStoriesView } from './BeeStoriesView';
import { SectionPicker } from './dash/SectionPicker';
import { clampRange } from './dash/useUrlRange';
import { RangePicker } from './dash/RangePicker';
import { InfoTip, DashTitle } from './dash/InfoTip';
import { DetailSheet } from './dash/DetailSheet';
import { GradeBreakdown, GradeChip, GradeFilter, GradeWhy, gradeRank, matchesGrade } from './BeeGrade';
import type { BeeLetter } from '../api/types';
import { type DateRange, previousRange, inRange, rangeText, nyToday, nyDay, daysBetween, bucketFor, bucketsIn, bucketStart, dayMs, addDays } from '../utils/dateRange';

/** Bedford Bee → Social (Facebook + Instagram). Rules in
 * worker/src/bee/social.ts. Likes, views, comments and shares lead every
 * view (Mike, 2026-10-11). */

const FB_COLOR = '#2A6FB0';
const IG_COLOR = '#C0662E';
const n0 = (n: number | null | undefined) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
const x1 = (n: number | null | undefined) => (n == null ? '—' : `${n.toFixed(1)}×`);
const toMs = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/New_York',
  });
const fmtShort = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
const fmtAxis = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
const PLAT: Record<string, string> = {
  fb: 'Facebook',
  ig: 'Instagram',
  all: 'Both',
};
const CORE: BeeMetric[] = ['views', 'likes', 'comments', 'shares'];
const LABEL: Record<BeeMetric, string> = {
  views: 'Views',
  likes: 'Likes',
  comments: 'Comments',
  shares: 'Shares',
  saves: 'Saves',
};
const headline = (t: string | null) => (t ?? '').split('\n')[0].trim() || '(no text)';
const tone = (r: number | null | undefined) => (r == null ? '' : r >= 1.5 ? ' bee-delta--up' : r <= 0.6 ? ' bee-delta--down' : '');

export function BeeSocialSection({ range, setRange }: { range: DateRange; setRange: (r: DateRange) => void }) {
  const [data, setData] = useState<BeeSocial | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () =>
    api
      .getBeeSocial()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  async function sync() {
    setBusy(true);
    try {
      const r = await api.syncBeeMeta();
      setMsg(`Synced ${r.fbPosts} Facebook and ${r.igPosts} Instagram posts.`);
      await load();
    } catch (e) {
      setMsg(apiError(e));
    } finally {
      setBusy(false);
    }
  }
  if (error) return <p className="fin-dash__muted">{error}</p>;
  if (!data) return <p className="fin-dash__muted">Loading…</p>;
  if (data.empty) {
    const c = data.connection;
    return (
      <section className="bee-section">
        <div className="bee-section__head">
          <h2 className="bee-section__title">Social</h2>
        </div>
        <div className="fin-dash__card">
          {c.connected ? (
            <>
              <p>
                Connected to {c.page}
                {c.instagram ? ` and @${c.instagram}` : ''}. Pull the post history:
              </p>
              <button type="button" className="btn btn--sm" onClick={sync} disabled={busy}>
                {busy ? 'Syncing… (a minute the first time)' : 'Sync Now'}
              </button>
            </>
          ) : (
            <p>
              Connect Facebook and Instagram in <Link to="/settings?cat=bee">Settings → Bedford Bee</Link>.
            </p>
          )}
          {(msg || c.lastError) && <p className="fin-dash__note">{msg ?? c.lastError}</p>}
        </div>
      </section>
    );
  }
  return <SocialBody data={data} onSync={sync} busy={busy} msg={msg} onReload={load} rangeIn={range} setRange={setRange} />;
}

type Loaded = Extract<BeeSocial, { empty: false }>;
type Plat = 'all' | 'fb' | 'ig';
type Totals = {
  posts: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
};
type TileKey = 'views' | 'likes' | 'comments' | 'shares' | 'posts';
const TILES: TileKey[] = ['views', 'likes', 'comments', 'shares', 'posts'];
const TILE_LABEL: Record<TileKey, string> = {
  ...LABEL,
  posts: 'Posts',
} as Record<TileKey, string>;

function sumPosts(ps: BeeSocialPost[]): Totals {
  const t: Totals = {
    posts: ps.length,
    views: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    saves: 0,
  };
  for (const p of ps) for (const k of ['views', 'likes', 'comments', 'shares', 'saves'] as const) t[k] += p[k] ?? 0;
  return t;
}
function changeVs(now: number, prev: number | null, label: string | null) {
  if (prev == null || label == null) return { text: '', tone: '' as const };
  if (!prev) return now ? { text: `new vs ${label}`, tone: 'up' as const } : { text: '', tone: '' as const };
  const d = (now - prev) / prev;
  if (Math.abs(d) < 0.05) return { text: `≈ ${label}`, tone: '' as const };
  return {
    text: `${d > 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(0)}% vs ${label}`,
    tone: d > 0 ? ('up' as const) : ('down' as const),
  };
}
const postDay = (p: BeeSocialPost) => nyDay(p.createdAt);

/** What the open drill-down sheet shows. */
type Sheet = { kind: 'metric'; metric: TileKey } | { kind: 'post'; post: BeeSocialPost } | { kind: 'posts'; title: string; sub?: string; posts: BeeSocialPost[] };

function SocialBody({ data, onSync, busy, msg, onReload, rangeIn, setRange }: { data: Loaded; onSync: () => void; busy: boolean; msg: string | null; onReload: () => void; rangeIn: DateRange; setRange: (r: DateRange) => void }) {
  const today = nyToday();
  const earliest = nyDay(data.range.from);
  const range = clampRange(rangeIn, earliest);
  const [plat, setPlat] = useState<Plat>('all');
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const prevR = previousRange(range);
  const platPosts = useMemo(() => data.posts.filter((p) => plat === 'all' || p.platform === plat), [data.posts, plat]);
  const inR = useMemo(() => platPosts.filter((p) => inRange(postDay(p), range)), [platPosts, range]);
  const inPrev = useMemo(() => (prevR ? platPosts.filter((p) => inRange(postDay(p), prevR)) : []), [platPosts, prevR]);
  const now = sumPosts(inR);
  const prev = prevR ? sumPosts(inPrev) : null;
  // keep an open post's numbers fresh after a tag save reloads data
  const openPost = (post: BeeSocialPost) => setSheet({ kind: 'post', post });

  const fbSeries = data.followers.fb.series;
  const igSeries = data.followers.ig.series;
  const followers = useMemo<LineSeries[]>(
    () =>
      [
        fbSeries.length > 1 && {
          name: 'Facebook',
          color: FB_COLOR,
          points: fbSeries.map((p) => ({ x: toMs(p.date), y: p.value })),
        },
        igSeries.length > 1 && {
          name: 'Instagram',
          color: IG_COLOR,
          points: igSeries.map((p) => ({ x: toMs(p.date), y: p.value })),
        },
      ].filter(Boolean) as LineSeries[],
    [fbSeries, igSeries],
  );
  return (
    <section className="bee-section">
      <div className="dash-controls">
        <RangePicker value={range} onChange={setRange} today={today} earliest={earliest} />
        <SectionPicker
          label="Platform"
          value={plat}
          onChange={setPlat}
          options={[
            ['all', 'Both Platforms'],
            ['fb', 'Facebook'],
            ['ig', 'Instagram'],
          ]}
        />
        <span className="dash-controls__range-text">
          {rangeText(range)}
          {prevR ? ` · vs ${rangeText(prevR)}` : ''}{' '}
          <InfoTip label="About these totals">
            <p>Totals are the lifetime views, likes, comments and shares of the posts published in this date range — a post from last week keeps counting its views here as they grow.</p>
            <p>The comparison is the same-length stretch just before (for Year to Date, the same dates last year).</p>
            <p>
              History: {data.range.fbPosts} Facebook and {data.range.igPosts} Instagram posts since {fmtDate(data.range.from)}. Tap any number for the detail.
            </p>
          </InfoTip>
        </span>
      </div>

      <div className="fin-dash__stats fin-dash__stats--5">
        {TILES.map((m) => {
          const ch = changeVs(now[m], prev ? prev[m] : null, prevR ? (range.key === 'ytd' ? 'last year' : prevR.label) : null);
          const sub = ch.text || (m === 'posts' ? `${(now.posts / Math.max(1, daysBetween(range.from, range.to))).toFixed(1)} a day` : now.posts ? `${n0(now[m] / now.posts)} per post` : '');
          return (
            <button key={m} type="button" className="fin-dash__stat" onClick={() => setSheet({ kind: 'metric', metric: m })}>
              <span className="fin-dash__stat-label">{TILE_LABEL[m]}</span>
              <span className="fin-dash__stat-value">{compact(now[m])}</span>
              {sub && <span className={`fin-dash__stat-sub${ch.tone === 'up' ? ' bee-delta--up' : ch.tone === 'down' ? ' bee-delta--down' : ''}`}>{sub}</span>}
            </button>
          );
        })}
      </div>

      <div className="fin-dash__grid">
        <PostScorecards posts={inR} plat={plat} range={range} onOpen={openPost} />
        <WeeklyCard data={data} plat={plat} range={range} onOpenWeek={(title, sub, posts) => setSheet({ kind: 'posts', title, sub, posts })} />
        <DayOfWeekCard
          data={data}
          plat={plat}
          onOpenDay={(title, posts) =>
            setSheet({
              kind: 'posts',
              title,
              sub: 'Posts at least a week old, last 12 months',
              posts,
            })
          }
        />
        <WhatWorksCard
          data={data}
          plat={plat}
          onOpenGroup={(title, posts) =>
            setSheet({
              kind: 'posts',
              title,
              sub: `${posts.length} posts, last 12 months`,
              posts,
            })
          }
        />
        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle info={<p>Instagram only shares the last 30 days of follower history, so its line starts when MikeOS began saving it.</p>}>Followers</DashTitle>
          <div className="fin-dash__stats bee-social__mini">
            <div className="fin-dash__stat">
              <span className="fin-dash__stat-label">Facebook</span>
              <span className="fin-dash__stat-value">{n0(data.followers.fb.now)}</span>
            </div>
            <div className="fin-dash__stat">
              <span className="fin-dash__stat-label">Instagram</span>
              <span className="fin-dash__stat-value">{n0(data.followers.ig.now)}</span>
              {data.followers.ig.newLast30 ? <span className="fin-dash__stat-sub">+{n0(data.followers.ig.newLast30)} in 30 days</span> : null}
            </div>
          </div>
          {followers.length > 0 && <FinanceLineChart series={followers} formatY={n0} formatX={fmtAxis} ariaLabel="Facebook and Instagram followers over time" yFromZero={false} />}
        </section>
      </div>

      <div className="dash-footer">
        <span>
          {data.connection.page}
          {data.connection.instagram ? ` · @${data.connection.instagram}` : ' · no Instagram linked'}
          {data.connection.lastRecentAt ? ` · synced ${new Date(data.connection.lastRecentAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}
        </span>
        <InfoTip label="About syncing">
          <p>Full sync from Meta every night; new posts every hour.</p>
        </InfoTip>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onSync} disabled={busy}>
          {busy ? 'Syncing…' : 'Sync Now'}
        </button>
        {(msg || data.connection.lastError) && <span className="fin-dash__note">{msg ?? data.connection.lastError}</span>}
      </div>

      {sheet?.kind === 'metric' && <MetricSheet metric={sheet.metric} posts={inR} prevPosts={inPrev} range={range} prevR={prevR} plat={plat} onClose={() => setSheet(null)} onOpenPost={openPost} />}
      {sheet?.kind === 'posts' && (
        <DetailSheet title={sheet.title} sub={sheet.sub} onClose={() => setSheet(null)}>
          <PostCardList posts={sheet.posts} onOpen={openPost} alwaysCards />
        </DetailSheet>
      )}
      {sheet?.kind === 'post' && (
        <DetailSheet title={headline(sheet.post.text)} onClose={() => setSheet(null)}>
          <Scorecard p={data.posts.find((x) => x.platform === sheet.post.platform && x.id === sheet.post.id) ?? sheet.post} data={data} onReload={onReload} />
        </DetailSheet>
      )}
    </section>
  );
}

const compact = (n: number) => (n >= 100000 ? `${(n / 1000).toFixed(0)}K` : n >= 10000 ? `${(n / 1000).toFixed(1)}K` : Math.round(n).toLocaleString('en-US'));

function MetricSheet({
  metric,
  posts,
  prevPosts,
  range,
  prevR,
  plat,
  onClose,
  onOpenPost,
}: {
  metric: TileKey;
  posts: BeeSocialPost[];
  prevPosts: BeeSocialPost[];
  range: DateRange;
  prevR: { from: string; to: string; label: string } | null;
  plat: Plat;
  onClose: () => void;
  onOpenPost: (p: BeeSocialPost) => void;
}) {
  const val = (ps: BeeSocialPost[]) => (metric === 'posts' ? ps.length : ps.reduce((s, p) => s + (p[metric] ?? 0), 0));
  const total = val(posts);
  const prevTotal = prevR ? val(prevPosts) : null;
  const fb = posts.filter((p) => p.platform === 'fb');
  const ig = posts.filter((p) => p.platform === 'ig');
  const bucket = bucketFor(range);
  const buckets = bucketsIn(range, bucket);
  const seriesFor = (ps: BeeSocialPost[]) => {
    const m = new Map(buckets.map((b) => [b, 0]));
    for (const p of ps) {
      const b = bucketStart(postDay(p), bucket);
      if (m.has(b)) m.set(b, (m.get(b) ?? 0) + (metric === 'posts' ? 1 : (p[metric] ?? 0)));
    }
    return buckets.map((b) => ({ x: dayMs(b), y: m.get(b) ?? 0 }));
  };
  const series: LineSeries[] =
    plat === 'all'
      ? [
          { name: 'Facebook', color: FB_COLOR, points: seriesFor(fb) },
          { name: 'Instagram', color: IG_COLOR, points: seriesFor(ig) },
        ]
      : [
          {
            name: PLAT[plat],
            color: plat === 'ig' ? IG_COLOR : FB_COLOR,
            points: seriesFor(posts),
          },
        ];
  const top = metric === 'posts' ? [...posts].sort((a, b) => gradeRank(b.grade) - gradeRank(a.grade)).slice(0, 8) : [...posts].sort((a, b) => (b[metric] ?? -1) - (a[metric] ?? -1)).slice(0, 8);
  const missing = metric === 'posts' ? 0 : posts.filter((p) => p[metric] == null).length;
  const ch = changeVs(total, prevTotal, prevR?.label ?? null);
  const fmtX = (ms: number) => new Date(ms).toLocaleDateString('en-US', bucket === 'month' ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' });
  return (
    <DetailSheet title={TILE_LABEL[metric]} sub={`${range.label} · ${rangeText(range)}${plat === 'all' ? '' : ` · ${PLAT[plat]}`}`} onClose={onClose}>
      <div className="dash-split">
        <div className="dash-split__item">
          <span className="fin-dash__stat-label">Total</span>
          <span className="dash-split__value">{n0(total)}</span>
          {ch.text && <span className={`fin-dash__stat-sub${ch.tone === 'up' ? ' bee-delta--up' : ch.tone === 'down' ? ' bee-delta--down' : ''}`}>{ch.text}</span>}
        </div>
        {prevTotal != null && (
          <div className="dash-split__item">
            <span className="fin-dash__stat-label">Before</span>
            <span className="dash-split__value">{n0(prevTotal)}</span>
            <span className="fin-dash__stat-sub">{prevR ? rangeText(prevR) : ''}</span>
          </div>
        )}
        {metric !== 'posts' && (
          <div className="dash-split__item">
            <span className="fin-dash__stat-label">Per Post</span>
            <span className="dash-split__value">{posts.length ? n0(total / posts.length) : '—'}</span>
            <span className="fin-dash__stat-sub">{posts.length} posts</span>
          </div>
        )}
        {plat === 'all' && (
          <>
            <div className="dash-split__item">
              <span className="fin-dash__stat-label">
                <span className="bee-social__dot bee-social__dot--fb" />
                Facebook
              </span>
              <span className="dash-split__value">{n0(val(fb))}</span>
              <span className="fin-dash__stat-sub">{total ? `${Math.round((val(fb) / total) * 100)}%` : '—'}</span>
            </div>
            <div className="dash-split__item">
              <span className="fin-dash__stat-label">
                <span className="bee-social__dot bee-social__dot--ig" />
                Instagram
              </span>
              <span className="dash-split__value">{n0(val(ig))}</span>
              <span className="fin-dash__stat-sub">{total ? `${Math.round((val(ig) / total) * 100)}%` : '—'}</span>
            </div>
          </>
        )}
      </div>
      <div className="dash-sheet__section">
        <h4>By {bucket === 'day' ? 'Day' : bucket === 'week' ? 'Week' : 'Month'} Posted</h4>
        <FinanceLineChart series={series} formatY={n0} formatX={fmtX} ariaLabel={`${TILE_LABEL[metric]} by ${bucket}`} height={200} />
      </div>
      {missing > 0 && (
        <p className="fin-dash__note">
          {missing} post{missing === 1 ? ' has' : 's have'} no {TILE_LABEL[metric].toLowerCase()} from Meta (counted as 0).
        </p>
      )}
      <div className="dash-sheet__section">
        <h4>{metric === 'posts' ? 'Best Scoring Posts' : `Top Posts by ${TILE_LABEL[metric]}`}</h4>
        {top.length ? <PostCardList posts={top} onOpen={onOpenPost} alwaysCards /> : <p className="fin-dash__muted">No posts in this range.</p>}
      </div>
    </DetailSheet>
  );
}

type SortKey = 'date' | 'grade' | 'score' | BeeMetric;

function PostScorecards({ posts, plat, range, onOpen }: { posts: BeeSocialPost[]; plat: Plat; range: DateRange; onOpen: (p: BeeSocialPost) => void }) {
  const [view, setView] = useState<'posts' | 'stories'>('posts');
  const toggle = (
    <SectionPicker
      label="Posts or stories"
      value={view}
      onChange={setView}
      options={[
        ['posts', 'By Platform'],
        ['stories', 'Stories (Combined)'],
      ]}
    />
  );
  if (view === 'stories')
    return (
      <section className="fin-dash__card fin-dash__card--full">
        <div className="fin-dash__card-head bee-posts__head">
          <DashTitle
            info={
              <>
                <p>A story = the same headline on Facebook and Instagram within 36 hours, plus the Substack post within 2 days. Totals add every platform; Substack views include email opens.</p>
                <p>Story grade = the parts’ grades combined (Facebook 40%, Instagram 35%, Substack 25% by default), then ranked against the stories before it — same A–F curve as posts. With Include Substack off, it’s Facebook + Instagram only. A paid Substack conversion is called out.</p>
              </>
            }
          >
            Stories
          </DashTitle>
          {toggle}
        </div>
        <BeeStoriesView platform={plat} range={range} />
      </section>
    );
  return <PostList posts={posts} onOpen={onOpen} toggle={toggle} />;
}

function PostList({ posts, onOpen, toggle }: { posts: BeeSocialPost[]; onOpen: (p: BeeSocialPost) => void; toggle: React.ReactNode }) {
  const [sort, setSort] = useState<SortKey>('date');
  const [tag, setTag] = useState('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(20);
  const [grade, setGrade] = useState<BeeLetter | 'pending' | null>(null);
  const allTags = [...new Set(posts.flatMap((p) => p.tags))].sort();
  const base = posts.filter((p) => (!tag || p.tags.includes(tag)) && (!q.trim() || (p.text ?? '').toLowerCase().includes(q.trim().toLowerCase())));
  const list = base
    .filter((p) => matchesGrade(p.grade, grade))
    .sort((a, b) =>
      sort === 'date'
        ? b.createdAt.localeCompare(a.createdAt)
        : sort === 'grade'
          ? gradeRank(b.grade) - gradeRank(a.grade)
          : sort === 'score'
            ? (b.score ?? -1) - (a.score ?? -1)
            : (b[sort] ?? -1) - (a[sort] ?? -1),
    );
  return (
    <section className="fin-dash__card fin-dash__card--full">
      <div className="fin-dash__card-head bee-posts__head">
        <DashTitle
          info={
            <>
              <p>
                Grade A–F = how the post ranks against the same platform’s posts from the 90 days before it (recent ones count more): A top 10%, B next 20%, C the typical middle, D below, F bottom 15%.
              </p>
              <p>
                It weighs views, likes, comments, shares (+ saves on Instagram), engagement per view and the day’s follows minus unfollows. A dashed grade is provisional: the post is under 3 days old, its numbers are projected from
                how past posts grew, and it can still move (↑ / ↓ since the last check). Under 3 hours old = too early.
              </p>
              <p>Each number’s ×multiple compares it with the median of the 60 posts before it. Weights and cutoffs are in Settings → Bedford Bee → Post Grades. Tap a post for its scorecard.</p>
            </>
          }
        >
          Posts ({list.length})
        </DashTitle>
        {toggle}
      </div>
      <GradeFilter grades={base.map((p) => p.grade)} value={grade} onChange={setGrade} />
      <div className="ally__txn-tools dash-card-tools">
        <input placeholder="Search Posts" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search posts" />
        <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Filter by tag">
          <option value="">All Tags</option>
          {allTags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort">
          <option value="date">Newest</option>
          <option value="grade">Best Grade</option>
          {CORE.map((m) => (
            <option key={m} value={m}>
              Most {LABEL[m]}
            </option>
          ))}
        </select>
      </div>
      {list.length ? (
        <>
          <div className="fin-dash__table-wrap post-table">
            <table className="fin-dash__table bee-posts bee-social__table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Post</th>
                  <th className="num">Grade</th>
                  {CORE.map((m) => (
                    <th key={m} className="num">
                      {LABEL[m]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.slice(0, limit).map((p) => (
                  <PostRow key={`${p.platform}|${p.id}`} p={p} onOpen={() => onOpen(p)} />
                ))}
              </tbody>
            </table>
          </div>
          <PostCardList posts={list.slice(0, limit)} onOpen={onOpen} />
        </>
      ) : (
        <p className="fin-dash__muted">No posts in this range.</p>
      )}
      {list.length > limit && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setLimit((l) => l + 40)}>
          Show More ({list.length - limit} left)
        </button>
      )}
    </section>
  );
}

function ScoreBadge({ p }: { p: BeeSocialPost }) {
  if (p.grade) return <GradeChip grade={p.grade} />;
  return p.mature ? (
    <span className={`bee-social__score bee-social__score--${(p.verdict ?? '').split(' ')[0].toLowerCase()}`}>{p.score ?? '—'}</span>
  ) : (
    <span className="bee-badge bee-badge--muted" title="Under a week old — compared with past posts at the same age">
      {p.early && p.early.baseline === 'same-age' ? `Early · ${p.early.bucket}` : 'So Far'}
    </span>
  );
}
const abShare = (m: Record<string, number>) => {
  const n = ['A', 'B', 'C', 'D', 'F'].reduce((t, l) => t + (m[l] ?? 0), 0);
  return n ? `${Math.round((((m.A ?? 0) + (m.B ?? 0)) / n) * 100)}%` : '—';
};
const ratiosOf = (p: BeeSocialPost) => (p.mature || !p.early ? p.vsTypical : p.early.vsTypical);
const ratioTone = (p: BeeSocialPost, r: number | null | undefined) => (p.mature || p.early?.baseline === 'same-age' ? tone(r) : '');

function PostRow({ p, onOpen }: { p: BeeSocialPost; onOpen: () => void }) {
  const ratios = ratiosOf(p);
  return (
    <tr className="bee-social__row" onClick={onOpen}>
      <td className="bee-posts__date">
        <span className={`bee-social__dot bee-social__dot--${p.platform}`} title={PLAT[p.platform]} />
        {fmtShort(p.createdAt)}
        <span className="fin-dash__muted"> · {p.day.slice(0, 3)}</span>
      </td>
      <td className="bee-posts__title">
        {headline(p.text)}
        <GradeWhy grade={p.grade} />
      </td>
      <td className="num">
        <ScoreBadge p={p} />
      </td>
      {CORE.map((m) => (
        <td key={m} className="num">
          {n0(p[m])}
          {ratios[m] != null && <span className={`bee-social__x${ratioTone(p, ratios[m])}`}> {x1(ratios[m])}</span>}
        </td>
      ))}
    </tr>
  );
}

/** Posts as tappable cards — the phone layout of the posts table, and the
 * list inside drill-down sheets everywhere. */
function PostCardList({ posts, onOpen, alwaysCards }: { posts: BeeSocialPost[]; onOpen: (p: BeeSocialPost) => void; alwaysCards?: boolean }) {
  return (
    <ul className="post-cards" style={alwaysCards ? { display: 'block' } : undefined}>
      {posts.map((p) => {
        const ratios = ratiosOf(p);
        return (
          <li key={`${p.platform}|${p.id}`}>
            <button type="button" className="post-card" onClick={() => onOpen(p)}>
              <div className="post-card__top">
                <span className={`bee-social__dot bee-social__dot--${p.platform}`} />
                {PLAT[p.platform]} · {fmtShort(p.createdAt)} · {p.day.slice(0, 3)}
                <ScoreBadge p={p} />
              </div>
              <div className="post-card__title">{headline(p.text)}</div>
              <GradeWhy grade={p.grade} />
              <div className="post-card__metrics">
                {CORE.map((m) => (
                  <span key={m} className="post-card__metric">
                    <span className="post-card__metric-label">{LABEL[m]}</span>
                    <span className="post-card__metric-value">
                      {compact(p[m] ?? 0)}
                      {ratios[m] != null && <span className={`bee-social__x${ratioTone(p, ratios[m])}`}> {x1(ratios[m])}</span>}
                    </span>
                  </span>
                ))}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Scorecard({ p, data, onReload }: { p: BeeSocialPost; data: Loaded; onReload: () => void }) {
  const [tagText, setTagText] = useState(p.manualTags.join(', '));
  const [saving, setSaving] = useState(false);
  const t = data.typical[p.platform];
  const metrics: BeeMetric[] = p.platform === 'ig' ? [...CORE, 'saves'] : CORE;
  async function saveTags() {
    setSaving(true);
    try {
      await api.setBeePostTags(
        p.platform,
        p.id,
        tagText
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      );
      onReload();
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="bee-scorecard">
      <div className="bee-scorecard__head">
        <div>
          <strong>{PLAT[p.platform]}</strong> · {p.day}, {fmtDate(p.createdAt)} · {p.format}
          {p.permalink && (
            <>
              {' '}
              ·{' '}
              <a href={p.permalink} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                Open Post
              </a>
            </>
          )}
        </div>
        <div className="bee-scorecard__verdict">
          {p.grade ? null : p.mature ? (
            <>
              <span className="bee-big">{p.score ?? '—'}</span> <span>{p.verdict}</span>
            </>
          ) : (
            <span>
              {p.early?.baseline === 'same-age'
                ? `Early read at ${p.early.bucket} — vs past posts at the same age`
                : 'Under a week old — numbers so far vs a typical post’s final numbers (still growing)'}
            </span>
          )}
        </div>
      </div>
      <p className="bee-scorecard__text">{p.text}</p>
      <GradeBreakdown grade={p.grade} title={`${PLAT[p.platform]} Grade`} />
      <div className="bee-scorecard__grid">
        {metrics.map((m) => {
          const r = p.mature || !p.early ? p.vsTypical[m] : p.early.vsTypical[m];
          return (
            <div key={m} className="bee-scorecard__metric">
              <span className="fin-dash__stat-label">{LABEL[m]}</span>
              <span className="bee-year__value">{n0(p[m])}</span>
              <span className={`fin-dash__stat-sub${tone(r)}`}>
                {r != null ? `${x1(r)} typical` : '—'}
                {t[m] != null ? ` · typical today ${n0(t[m])}` : ''}
              </span>
            </div>
          );
        })}
      </div>
      <p className="fin-dash__muted">
        Per 1,000 views: {p.per1k.likes != null ? p.per1k.likes.toFixed(1) : '—'} likes · {p.per1k.comments != null ? p.per1k.comments.toFixed(1) : '—'} comments ·{' '}
        {p.per1k.shares != null ? p.per1k.shares.toFixed(1) : '—'} shares
        {p.reach != null ? ` · reached ${n0(p.reach)} accounts` : ''}
        {p.siteVisits != null ? ` · ${n0(p.siteVisits)} website visits from Facebook in the week after` : ''}
      </p>
      {p.story && (
        <p className="fin-dash__note">
          Same story on Substack: “{p.story.title}” — {n0(p.story.sent)} emailed, {n0(p.story.opened)} opened, {n0(p.story.views)} views.
        </p>
      )}
      <div className="bee-badges bee-scorecard__tags">
        {p.tags.map((tg) => (
          <span key={tg} className={`bee-badge${tg.startsWith('Tag:') ? ' bee-badge--fwd' : ''}`}>
            {tg}
          </span>
        ))}
      </div>
      <div className="toolbar-row bee-key-row" onClick={(e) => e.stopPropagation()}>
        <input placeholder="Your tags, comma-separated (e.g. satire, news)" value={tagText} onChange={(e) => setTagText(e.target.value)} />
        <button className="btn btn--sm" onClick={saveTags} disabled={saving}>
          {saving ? 'Saving…' : 'Save Tags'}
        </button>
      </div>
    </div>
  );
}

function WeeklyCard({ data, plat, range, onOpenWeek }: { data: Loaded; plat: Plat; range: DateRange; onOpenWeek: (title: string, sub: string, posts: BeeSocialPost[]) => void }) {
  const side = (w: Loaded['weekly'][number]) =>
    plat === 'all'
      ? (['posts', 'views', 'likes', 'comments', 'shares', 'newFollowers'] as const).reduce((o, k) => ({ ...o, [k]: w.fb[k] + w.ig[k] }), {} as Record<string, number>)
      : (w[plat] as unknown as Record<string, number>);
  const weeks = data.weekly.filter((w) => addDays(w.week, 6) >= range.from && w.week <= range.to);
  const open = (w: Loaded['weekly'][number]) => {
    const end = addDays(w.week, 6);
    const posts = data.posts.filter((p) => (plat === 'all' || p.platform === plat) && inRange(nyDay(p.createdAt), { from: w.week, to: end })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const s = side(w);
    onOpenWeek(
      `Week of ${fmtShort(`${w.week}T16:00:00Z`)}`,
      `${n0(s.posts)} posts · ${n0(s.views)} views · ${n0(s.likes)} likes${w.substack ? ` · ${n0(w.substack.opened)} email opens · ${n0(w.substack.siteVisits)} site visits` : ''}`,
      posts,
    );
  };
  return (
    <section className="fin-dash__card fin-dash__card--full">
      <DashTitle
        info={
          <p>
            Monday–Sunday, numbers for the posts published that week. Email opens = unique opens of that week’s Substack emails; site visits from Google Analytics. Instagram followers per week only
            for the last 30 days. Tap a week for its posts.
          </p>
        }
      >
        Weekly Scorecard
      </DashTitle>
      {weeks.length ? (
        <div className="fin-dash__table-wrap">
          <table className="fin-dash__table bee-posts">
            <thead>
              <tr>
                <th>Week Of</th>
                <th className="num">Posts</th>
                <th className="num">Views</th>
                <th className="num">Likes</th>
                <th className="num bee-hide-sm">Comments</th>
                <th className="num bee-hide-sm">Shares</th>
                <th className="num bee-hide-sm">Followers</th>
                <th className="num bee-hide-sm">Email Opens</th>
                <th className="num bee-hide-sm">Site Visits</th>
                <th className="bee-hide-sm">Best Post</th>
              </tr>
            </thead>
            <tbody>
              {weeks.map((w) => {
                const s = side(w);
                return (
                  <tr key={w.week} className="bee-social__row" onClick={() => open(w)}>
                    <td>{fmtShort(`${w.week}T16:00:00Z`)}</td>
                    <td className="num">{n0(s.posts)}</td>
                    <td className="num">{n0(s.views)}</td>
                    <td className="num">{n0(s.likes)}</td>
                    <td className="num bee-hide-sm">{n0(s.comments)}</td>
                    <td className="num bee-hide-sm">{n0(s.shares)}</td>
                    <td className="num bee-hide-sm">{s.newFollowers ? `${s.newFollowers > 0 ? '+' : ''}${n0(s.newFollowers)}` : '—'}</td>
                    <td className="num bee-hide-sm">{n0(w.substack?.opened)}</td>
                    <td className="num bee-hide-sm">{n0(w.substack?.siteVisits)}</td>
                    <td className="bee-hide-sm bee-web__landing">{w.best ? `${w.best.text} (${w.best.grade ?? w.best.score})` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="fin-dash__muted">No weeks in this range.</p>
      )}
    </section>
  );
}

function DayOfWeekCard({ data, plat, onOpenDay }: { data: Loaded; plat: Plat; onOpenDay: (title: string, posts: BeeSocialPost[]) => void }) {
  const yearAgo = addDays(nyToday(), -365);
  const [metric, setMetric] = useState<'score' | 'views' | 'likes' | 'comments' | 'shares'>('score');
  const sets = data.dayOfWeek.filter((d) => plat === 'all' || d.platform === plat);
  return (
    <section className="fin-dash__card">
      <div className="fin-dash__card-head">
        <DashTitle
          info={
            <p>
              Median per post over the last 12 months (posts at least a week old), whatever range is picked above. The small number is how many posts. Everything posts at 3pm, so time of day is left
              out. Tap a day for its posts.
            </p>
          }
        >
          Day of the Week
        </DashTitle>
        <select value={metric} onChange={(e) => setMetric(e.target.value as typeof metric)} aria-label="Metric" className="bee-social__select">
          <option value="score">Typical Score</option>
          {CORE.map((m) => (
            <option key={m} value={m}>
              Typical {LABEL[m]}
            </option>
          ))}
        </select>
      </div>
      {sets.map((s) => {
        const max = Math.max(1, ...s.days.map((d) => d[metric] ?? 0));
        return (
          <div key={s.platform}>
            {sets.length > 1 && <h4 className="fin-dash__subtitle">{PLAT[s.platform]}</h4>}
            <div className="bee-bars">
              {s.days.map((d) => (
                <button
                  key={d.day}
                  type="button"
                  className="bee-bars__row"
                  onClick={() =>
                    onOpenDay(
                      `${d.day}s · ${PLAT[s.platform]}`,
                      data.posts.filter((p) => p.platform === s.platform && p.day === d.day && p.mature && nyDay(p.createdAt) >= yearAgo).sort((a, b) => (b.score ?? -1) - (a.score ?? -1)),
                    )
                  }
                >
                  <span className="bee-bars__label">{d.day}</span>
                  <span className="bee-bars__track">
                    <span
                      className="bee-bars__bar"
                      style={{
                        width: `${((d[metric] ?? 0) / max) * 100}%`,
                        background: s.platform === 'ig' ? IG_COLOR : FB_COLOR,
                      }}
                    />
                  </span>
                  <span className="bee-bars__value">
                    {metric === 'score' ? (d.score ?? '—') : n0(d[metric])}
                    <span className="fin-dash__muted"> · {d.posts}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function WhatWorksCard({ data, plat, onOpenGroup }: { data: Loaded; plat: Plat; onOpenGroup: (title: string, posts: BeeSocialPost[]) => void }) {
  const yearAgo = addDays(nyToday(), -365);
  const [kind, setKind] = useState<'Format' | 'Topic' | 'Style' | 'Tag'>('Topic');
  const sets = data.tagPerf.filter((d) => plat === 'all' || d.platform === plat);
  return (
    <section className="fin-dash__card">
      <div className="fin-dash__card-head">
        <DashTitle
          info={
            <p>
              Last 12 months. Median score of the posts in each group, and their typical views / shares / comments vs all posts on that platform. Topics come from whole-word keyword rules in the
              headline, editable in <Link to="/settings?cat=bee">Settings → Bedford Bee</Link>. Tap a group for its posts.
            </p>
          }
        >
          What Works
        </DashTitle>
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Tag type" className="bee-social__select">
          <option value="Topic">By Topic</option>
          <option value="Format">By Format</option>
          <option value="Style">By Headline Style</option>
          <option value="Tag">By Your Tags</option>
        </select>
      </div>
      {sets.map((s) => {
        const rows = s.rows.filter((r) => r.tag.startsWith(`${kind}:`));
        return (
          <div key={s.platform}>
            {sets.length > 1 && <h4 className="fin-dash__subtitle">{PLAT[s.platform]}</h4>}
            {rows.length ? (
              <ul className="bee-list">
                {rows.map((r) => (
                  <li
                    key={r.tag}
                    className="bee-list__row bee-list__row--click"
                    role="button"
                    tabIndex={0}
                    onClick={() =>
                      onOpenGroup(
                        `${r.tag.replace(/^[^:]+:\s*/, '')} · ${PLAT[s.platform]}`,
                        data.posts.filter((p) => p.platform === s.platform && p.tags.includes(r.tag) && nyDay(p.createdAt) >= yearAgo).sort((a, b) => gradeRank(b.grade) - gradeRank(a.grade)),
                      )
                    }
                  >
                    <span>
                      {r.tag.replace(/^[^:]+:\s*/, '')}
                      <span className="fin-dash__muted">
                        {' '}
                        · {r.posts} posts{r.few ? ' (few)' : ''}
                      </span>
                    </span>
                    <span className="bee-list__meta">
                      {r.grades ? `${abShare(r.grades)} A–B` : `score ${r.score ?? '—'}`} · <span className={tone(r.views)}>views {x1(r.views)}</span> · <span className={tone(r.shares)}>shares {x1(r.shares)}</span> ·{' '}
                      <span className={tone(r.comments)}>comments {x1(r.comments)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="fin-dash__muted">{kind === 'Tag' ? 'Tag posts in their scorecards to compare them here.' : 'Not enough posts yet (3+ per group).'}</p>
            )}
          </div>
        );
      })}
    </section>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { BeeMetric, BeeSocial, BeeSocialPost } from '../api/types';
import { FinanceLineChart } from './FinanceLineChart';
import type { LineSeries } from './FinanceLineChart';
import { apiError } from './BeeMicrosoftSections';

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
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
const fmtShort = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
const fmtAxis = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
const PLAT: Record<string, string> = { fb: 'Facebook', ig: 'Instagram', all: 'Both' };
const CORE: BeeMetric[] = ['views', 'likes', 'comments', 'shares'];
const LABEL: Record<BeeMetric, string> = { views: 'Views', likes: 'Likes', comments: 'Comments', shares: 'Shares', saves: 'Saves' };
const headline = (t: string | null) => (t ?? '').split('\n')[0].trim() || '(no text)';
function change(now: number, prev: number) {
  if (!prev) return now ? { text: 'new', tone: 'up' as const } : { text: '', tone: '' as const };
  const d = (now - prev) / prev;
  if (Math.abs(d) < 0.05) return { text: 'about the same', tone: '' as const };
  return { text: `${d > 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(0)}% vs prior 28 days`, tone: d > 0 ? ('up' as const) : ('down' as const) };
}
const tone = (r: number | null | undefined) => (r == null ? '' : r >= 1.5 ? ' bee-delta--up' : r <= 0.6 ? ' bee-delta--down' : '');

export function BeeSocialSection() {
  const [data, setData] = useState<BeeSocial | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => api.getBeeSocial().then(setData).catch((e: Error) => setError(e.message));
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
  return <SocialBody data={data} onSync={sync} busy={busy} msg={msg} onReload={load} />;
}

type Loaded = Extract<BeeSocial, { empty: false }>;

function SocialBody({ data, onSync, busy, msg, onReload }: { data: Loaded; onSync: () => void; busy: boolean; msg: string | null; onReload: () => void }) {
  const [plat, setPlat] = useState<'all' | 'fb' | 'ig'>('all');
  const now = data.period.now[plat];
  const prev = data.period.prev[plat];
  const fbSeries = data.followers.fb.series;
  const igSeries = data.followers.ig.series;
  const followers = useMemo<LineSeries[]>(
    () =>
      [
        fbSeries.length > 1 && { name: 'Facebook', color: FB_COLOR, points: fbSeries.map((p) => ({ x: toMs(p.date), y: p.value })) },
        igSeries.length > 1 && { name: 'Instagram', color: IG_COLOR, points: igSeries.map((p) => ({ x: toMs(p.date), y: p.value })) },
      ].filter(Boolean) as LineSeries[],
    [fbSeries, igSeries]
  );
  return (
    <section className="bee-section">
      <div className="bee-section__head">
        <h2 className="bee-section__title">Social</h2>
        <span className="fin-dash__muted">
          {data.range.fbPosts} Facebook · {data.range.igPosts} Instagram posts since {fmtDate(data.range.from)}
        </span>
        <div className="ally__range bee-tabs bee-social__plat" role="tablist" aria-label="Platform">
          {(['all', 'fb', 'ig'] as const).map((p) => (
            <button key={p} type="button" role="tab" aria-selected={plat === p} className={`btn btn--sm${plat === p ? ' is-active' : ' btn--ghost'}`} onClick={() => setPlat(p)}>
              {PLAT[p]}
            </button>
          ))}
        </div>
      </div>

      <div className="fin-dash__stats">
        {CORE.map((m) => {
          const ch = change(now[m], prev[m]);
          return <Stat key={m} label={LABEL[m]} value={n0(now[m])} sub={`${ch.text || `${now.posts} posts`}`} tone={ch.tone} />;
        })}
      </div>
      <p className="fin-dash__muted bee-social__sub">
        Last 28 days · {now.posts} posts · per post: {n0(now.posts ? now.views / now.posts : null)} views, {n0(now.posts ? now.likes / now.posts : null)} likes, {(now.posts ? now.comments / now.posts : 0).toFixed(1)} comments,{' '}
        {(now.posts ? now.shares / now.posts : 0).toFixed(1)} shares
      </p>

      <div className="fin-dash__grid">
        <PostScorecards data={data} plat={plat} onReload={onReload} />
        <WeeklyCard data={data} plat={plat} />
        <DayOfWeekCard data={data} plat={plat} />
        <WhatWorksCard data={data} plat={plat} />
        <section className="fin-dash__card fin-dash__card--full">
          <h3 className="fin-dash__card-title">Followers</h3>
          <div className="fin-dash__stats bee-social__mini">
            <Stat label="Facebook" value={n0(data.followers.fb.now)} />
            <Stat label="Instagram" value={n0(data.followers.ig.now)} sub={data.followers.ig.newLast30 ? `+${n0(data.followers.ig.newLast30)} new in 30 days` : undefined} />
          </div>
          {followers.length ? (
            <FinanceLineChart series={followers} formatY={n0} formatX={fmtAxis} ariaLabel="Facebook and Instagram followers over time" yFromZero={false} />
          ) : (
            <p className="fin-dash__muted">Follower history builds from here — Instagram only shares the last 30 days.</p>
          )}
        </section>
        <section className="fin-dash__card fin-dash__card--full">
          <div className="fin-dash__card-head">
            <h3 className="fin-dash__card-title">Meta Connection</h3>
            <button type="button" className="btn btn--ghost btn--sm" onClick={onSync} disabled={busy}>
              {busy ? 'Syncing…' : 'Sync Now'}
            </button>
          </div>
          <p className="fin-dash__muted">
            {data.connection.page}
            {data.connection.instagram ? ` · @${data.connection.instagram}` : ' · no Instagram linked'} · full sync nightly, new posts hourly
            {data.connection.lastRecentAt ? ` (last ${new Date(data.connection.lastRecentAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })})` : ''}.
          </p>
          {(msg || data.connection.lastError) && <p className="fin-dash__note">{msg ?? data.connection.lastError}</p>}
        </section>
      </div>
    </section>
  );
}

type SortKey = 'date' | 'score' | BeeMetric;

function PostScorecards({ data, plat, onReload }: { data: Loaded; plat: 'all' | 'fb' | 'ig'; onReload: () => void }) {
  const [sort, setSort] = useState<SortKey>('date');
  const [tag, setTag] = useState('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(20);
  const [open, setOpen] = useState<string | null>(null);
  const allTags = [...new Set(data.posts.flatMap((p) => p.tags))].sort();
  const list = data.posts
    .filter((p) => (plat === 'all' || p.platform === plat) && (!tag || p.tags.includes(tag)) && (!q.trim() || (p.text ?? '').toLowerCase().includes(q.trim().toLowerCase())))
    .sort((a, b) => (sort === 'date' ? b.createdAt.localeCompare(a.createdAt) : sort === 'score' ? (b.score ?? -1) - (a.score ?? -1) : (b[sort] ?? -1) - (a[sort] ?? -1)));
  return (
    <section className="fin-dash__card fin-dash__card--full">
      <div className="fin-dash__card-head bee-posts__head">
        <h3 className="fin-dash__card-title">Post Scorecards</h3>
        <div className="ally__txn-tools">
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
            <option value="date">Sort: Newest</option>
            <option value="score">Sort: Score</option>
            {CORE.map((m) => (
              <option key={m} value={m}>
                Sort: {LABEL[m]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="fin-dash__table-wrap">
        <table className="fin-dash__table bee-posts bee-social__table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Post</th>
              <th className="num">Score</th>
              {CORE.map((m) => (
                <th key={m} className={`num${m === 'views' ? '' : ' bee-hide-sm'}`}>
                  {LABEL[m]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.slice(0, limit).map((p) => {
              const key = `${p.platform}|${p.id}`;
              const isOpen = open === key;
              return (
                <PostRow key={key} p={p} open={isOpen} onToggle={() => setOpen(isOpen ? null : key)} data={data} onReload={onReload} />
              );
            })}
          </tbody>
        </table>
      </div>
      {list.length > limit && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setLimit((l) => l + 40)}>
          Show More ({list.length - limit} left)
        </button>
      )}
      <p className="fin-dash__note">
        Each number shows its multiple of a typical post at the time: the median of the 60 posts before it on that platform, so older posts are judged against the audience they had. Score = how the
        post ranks on views, likes, comments and shares (+ saves on Instagram) against those 60. Posts under a week old show numbers so far. Click a post for its scorecard.
      </p>
    </section>
  );
}

function PostRow({ p, open, onToggle, data, onReload }: { p: BeeSocialPost; open: boolean; onToggle: () => void; data: Loaded; onReload: () => void }) {
  const ratios = p.mature || !p.early ? p.vsTypical : p.early.vsTypical;
  return (
    <>
      <tr className="bee-social__row" onClick={onToggle} aria-expanded={open}>
        <td className="bee-posts__date">
          <span className={`bee-social__dot bee-social__dot--${p.platform}`} title={PLAT[p.platform]} />
          {fmtShort(p.createdAt)}
          <span className="bee-hide-sm fin-dash__muted"> · {p.day.slice(0, 3)}</span>
        </td>
        <td className="bee-posts__title">{headline(p.text)}</td>
        <td className="num">
          {p.mature ? (
            <span className={`bee-social__score bee-social__score--${(p.verdict ?? '').split(' ')[0].toLowerCase()}`}>{p.score ?? '—'}</span>
          ) : (
            <span className="bee-badge bee-badge--muted" title="Under a week old — compared with past posts at the same age">
              {p.early && p.early.baseline === 'same-age' ? `Early · ${p.early.bucket}` : 'So Far'}
            </span>
          )}
        </td>
        {CORE.map((m) => (
          <td key={m} className={`num${m === 'views' ? '' : ' bee-hide-sm'}`}>
            {n0(p[m])}
            {ratios[m] != null && <span className={`bee-social__x${p.mature || p.early?.baseline === 'same-age' ? tone(ratios[m]) : ''}`}> {x1(ratios[m])}</span>}
          </td>
        ))}
      </tr>
      {open && (
        <tr className="bee-social__detail">
          <td colSpan={7}>
            <Scorecard p={p} data={data} onReload={onReload} />
          </td>
        </tr>
      )}
    </>
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
        tagText.split(',').map((x) => x.trim()).filter(Boolean)
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
          {p.mature ? (
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

function WeeklyCard({ data, plat }: { data: Loaded; plat: 'all' | 'fb' | 'ig' }) {
  const side = (w: Loaded['weekly'][number]) =>
    plat === 'all'
      ? (['posts', 'views', 'likes', 'comments', 'shares', 'newFollowers'] as const).reduce((o, k) => ({ ...o, [k]: w.fb[k] + w.ig[k] }), {} as Record<string, number>)
      : (w[plat] as unknown as Record<string, number>);
  return (
    <section className="fin-dash__card fin-dash__card--full">
      <h3 className="fin-dash__card-title">Weekly Scorecard</h3>
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
            {data.weekly.map((w) => {
              const s = side(w);
              return (
                <tr key={w.week}>
                  <td>{fmtShort(`${w.week}T16:00:00Z`)}</td>
                  <td className="num">{n0(s.posts)}</td>
                  <td className="num">{n0(s.views)}</td>
                  <td className="num">{n0(s.likes)}</td>
                  <td className="num bee-hide-sm">{n0(s.comments)}</td>
                  <td className="num bee-hide-sm">{n0(s.shares)}</td>
                  <td className="num bee-hide-sm">{s.newFollowers ? `${s.newFollowers > 0 ? '+' : ''}${n0(s.newFollowers)}` : '—'}</td>
                  <td className="num bee-hide-sm">{n0(w.substack?.opened)}</td>
                  <td className="num bee-hide-sm">{n0(w.substack?.siteVisits)}</td>
                  <td className="bee-hide-sm bee-web__landing">{w.best ? `${w.best.text} (${w.best.score})` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="fin-dash__note">Monday–Sunday. Email opens = unique opens of that week’s Substack emails; site visits from Google Analytics. Instagram followers per week only for the last 30 days.</p>
    </section>
  );
}

function DayOfWeekCard({ data, plat }: { data: Loaded; plat: 'all' | 'fb' | 'ig' }) {
  const [metric, setMetric] = useState<'score' | 'views' | 'likes' | 'comments' | 'shares'>('score');
  const sets = data.dayOfWeek.filter((d) => plat === 'all' || d.platform === plat);
  return (
    <section className="fin-dash__card">
      <div className="fin-dash__card-head">
        <h3 className="fin-dash__card-title">Day of the Week</h3>
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
                <div key={d.day} className="bee-bars__row bee-bars__row--static">
                  <span className="bee-bars__label">{d.day}</span>
                  <span className="bee-bars__track">
                    <span className="bee-bars__bar" style={{ width: `${((d[metric] ?? 0) / max) * 100}%`, background: s.platform === 'ig' ? IG_COLOR : FB_COLOR }} />
                  </span>
                  <span className="bee-bars__value">
                    {metric === 'score' ? (d.score ?? '—') : n0(d[metric])}
                    <span className="fin-dash__muted"> · {d.posts}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      <p className="fin-dash__note">Median per post over the last year (posts at least a week old) · the small number is how many posts. Everything posts at 3pm, so time of day is left out.</p>
    </section>
  );
}

function WhatWorksCard({ data, plat }: { data: Loaded; plat: 'all' | 'fb' | 'ig' }) {
  const [kind, setKind] = useState<'Format' | 'Topic' | 'Style' | 'Tag'>('Topic');
  const sets = data.tagPerf.filter((d) => plat === 'all' || d.platform === plat);
  return (
    <section className="fin-dash__card">
      <div className="fin-dash__card-head">
        <h3 className="fin-dash__card-title">What Works</h3>
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
                  <li key={r.tag} className="bee-list__row">
                    <span>
                      {r.tag.replace(/^[^:]+:\s*/, '')}
                      <span className="fin-dash__muted">
                        {' '}
                        · {r.posts} posts{r.few ? ' (few)' : ''}
                      </span>
                    </span>
                    <span className="bee-list__meta">
                      score {r.score ?? '—'} · <span className={tone(r.views)}>views {x1(r.views)}</span> · <span className={tone(r.shares)}>shares {x1(r.shares)}</span> ·{' '}
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
      <p className="fin-dash__note">
        Median score of the posts in each group, and their typical views / shares / comments vs all posts on that platform. Topics come from whole-word keyword rules you can edit in <Link to="/settings?cat=bee">Settings → Bedford Bee</Link>.
      </p>
    </section>
  );
}

function Stat({ label, value, sub, tone: t }: { label: string; value: string; sub?: string; tone?: '' | 'up' | 'down' }) {
  return (
    <div className="fin-dash__stat">
      <span className="fin-dash__stat-label">{label}</span>
      <span className="fin-dash__stat-value">{value}</span>
      {sub && <span className={`fin-dash__stat-sub${t === 'up' ? ' bee-delta--up' : t === 'down' ? ' bee-delta--down' : ''}`}>{sub}</span>}
    </div>
  );
}

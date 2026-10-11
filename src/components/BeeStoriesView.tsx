import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { BeeStory, BeeStoryPart } from '../api/types';

/** Social → Stories: the same post on Facebook, Instagram and Substack as
 * one story, combined and by platform (worker/src/bee/stories.ts). */

const n0 = (n: number | null | undefined) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
const fmtDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
const PLAT: Record<string, string> = { fb: 'Facebook', ig: 'Instagram', substack: 'Substack' };
type Key = 'views' | 'likes' | 'comments' | 'shares';
const KEYS: Key[] = ['views', 'likes', 'comments', 'shares'];
const LABEL: Record<Key, string> = { views: 'Views', likes: 'Likes', comments: 'Comments', shares: 'Shares' };

export function BeeStoriesView({ platform }: { platform: 'all' | 'fb' | 'ig' }) {
  const [stories, setStories] = useState<BeeStory[] | null>(null);
  const [withSubstack, setWithSubstack] = useState(true);
  const [sort, setSort] = useState<'date' | 'score' | Key>('date');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(25);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    api
      .getBeeStories()
      .then((r) => setStories(r.stories))
      .catch(() => setStories([]));
  }, []);
  if (!stories) return <p className="fin-dash__muted">Loading stories…</p>;

  const totals = (s: BeeStory) => (withSubstack ? s.total : s.social);
  const score = (s: BeeStory) => (withSubstack ? s.score : s.scoreSocial);
  const list = stories
    .filter((s) => (platform === 'all' ? true : s.parts.some((p) => p.platform === platform)) && (withSubstack || s.parts.some((p) => p.platform !== 'substack')))
    .filter((s) => !q.trim() || s.headline.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => (sort === 'date' ? b.createdAt.localeCompare(a.createdAt) : sort === 'score' ? (score(b) ?? -1) - (score(a) ?? -1) : totals(b)[sort] - totals(a)[sort]));
  const all3 = stories.filter((s) => s.parts.length === 3).length;

  return (
    <>
      <div className="bee-posts__head bee-stories__tools">
        <div className="ally__txn-tools">
          <input placeholder="Search Stories" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search stories" />
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
            <option value="date">Sort: Newest</option>
            <option value="score">Sort: Combined Score</option>
            {KEYS.map((k) => (
              <option key={k} value={k}>
                Sort: Total {LABEL[k]}
              </option>
            ))}
          </select>
          <label className="bee-stories__toggle">
            <input type="checkbox" checked={withSubstack} onChange={(e) => setWithSubstack(e.target.checked)} /> Include Substack
          </label>
        </div>
      </div>
      <div className="fin-dash__table-wrap">
        <table className="fin-dash__table bee-posts bee-social__table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Story</th>
              <th>On</th>
              <th className="num">Score</th>
              {KEYS.map((k) => (
                <th key={k} className={`num${k === 'views' ? '' : ' bee-hide-sm'}`}>
                  {LABEL[k]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.slice(0, limit).map((s) => {
              const isOpen = open === s.key;
              const t = totals(s);
              const sc = score(s);
              return (
                <StoryRows key={s.key} s={s} open={isOpen} onToggle={() => setOpen(isOpen ? null : s.key)} t={t} sc={sc} withSubstack={withSubstack} />
              );
            })}
          </tbody>
        </table>
      </div>
      {list.length > limit && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setLimit((l) => l + 50)}>
          Show More ({list.length - limit} left)
        </button>
      )}
      <p className="fin-dash__note">
        A story = the same headline on Facebook and Instagram within 36 hours, plus the Substack post within 2 days ({all3} stories ran on all three). Totals add every platform; Substack views include email
        opens. Combined score = how the story ranks on total views, likes, comments and shares against the 60 stories before it. Click a story for the breakdown.
      </p>
    </>
  );
}

function StoryRows({ s, open, onToggle, t, sc, withSubstack }: { s: BeeStory; open: boolean; onToggle: () => void; t: BeeStory['total']; sc: number | null; withSubstack: boolean }) {
  const parts = withSubstack ? s.parts : s.parts.filter((p) => p.platform !== 'substack');
  return (
    <>
      <tr className="bee-social__row" onClick={onToggle} aria-expanded={open}>
        <td className="bee-posts__date">{fmtDate(s.date)}</td>
        <td className="bee-posts__title">{s.headline}</td>
        <td className="bee-stories__on">
          {s.parts.map((p) => (
            <span key={p.platform} className={`bee-social__dot bee-social__dot--${p.platform}`} title={PLAT[p.platform]} />
          ))}
        </td>
        <td className="num">
          {s.mature ? <span className={`bee-social__score bee-social__score--${sc == null ? '' : sc >= 90 ? 'top' : sc >= 65 ? 'above' : sc >= 35 ? 'typical' : 'below'}`}>{sc ?? '—'}</span> : <span className="bee-badge bee-badge--muted">So Far</span>}
        </td>
        {KEYS.map((k) => (
          <td key={k} className={`num${k === 'views' ? '' : ' bee-hide-sm'}`}>
            {n0(t[k])}
          </td>
        ))}
      </tr>
      {open && (
        <tr className="bee-social__detail">
          <td colSpan={8}>
            <div className="bee-scorecard">
              <div className="fin-dash__table-wrap">
                <table className="fin-dash__table bee-table--compact">
                  <thead>
                    <tr>
                      <th>Platform</th>
                      {KEYS.map((k) => (
                        <th key={k} className="num">
                          {LABEL[k]}
                        </th>
                      ))}
                      <th className="num bee-hide-sm">Share of Views</th>
                      <th className="bee-hide-sm" />
                    </tr>
                  </thead>
                  <tbody>
                    {parts.map((p) => (
                      <PartRow key={p.platform} p={p} totalViews={t.views} />
                    ))}
                    <tr className="bee-money__strong">
                      <td>Total</td>
                      {KEYS.map((k) => (
                        <td key={k} className="num">
                          {n0(t[k])}
                        </td>
                      ))}
                      <td className="bee-hide-sm" />
                      <td className="bee-hide-sm" />
                    </tr>
                  </tbody>
                </table>
              </div>
              {(() => {
                const sub = s.parts.find((p) => p.platform === 'substack');
                return sub?.extra ? (
                  <p className="fin-dash__muted">
                    Substack: {n0(sub.extra.sent)} emailed · {n0(sub.extra.opened)} opened ({sub.extra.sent ? Math.round(((sub.extra.opened ?? 0) / sub.extra.sent) * 100) : 0}%) · {n0(sub.extra.signups)} free + {n0(sub.extra.paid)} paid
                    subscribers gained
                  </p>
                ) : null;
              })()}
              {s.parts.some((p) => p.platform === 'ig' && p.saves) && <p className="fin-dash__muted">Instagram saves: {n0(s.parts.find((p) => p.platform === 'ig')?.saves)}</p>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function PartRow({ p, totalViews }: { p: BeeStoryPart; totalViews: number }) {
  return (
    <tr>
      <td>
        <span className={`bee-social__dot bee-social__dot--${p.platform}`} />
        {PLAT[p.platform]}
      </td>
      {KEYS.map((k) => (
        <td key={k} className="num">
          {n0(p[k])}
        </td>
      ))}
      <td className="num bee-hide-sm">{totalViews ? `${Math.round(((p.views ?? 0) / totalViews) * 100)}%` : '—'}</td>
      <td className="bee-hide-sm">
        {p.permalink && (
          <a href={p.permalink} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
            Open
          </a>
        )}
      </td>
    </tr>
  );
}

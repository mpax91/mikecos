import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { BeeStory, BeeStoryPart } from '../api/types';
import { DetailSheet } from './dash/DetailSheet';
import { inRange, type DateRange } from '../utils/dateRange';

/** Social → Stories: the same post on Facebook, Instagram and Substack as
 * one story, combined and by platform (worker/src/bee/stories.ts). */

const n0 = (n: number | null | undefined) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
const fmtDate = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: '2-digit',
  });
const PLAT: Record<string, string> = {
  fb: 'Facebook',
  ig: 'Instagram',
  substack: 'Substack',
};
type Key = 'views' | 'likes' | 'comments' | 'shares';
const KEYS: Key[] = ['views', 'likes', 'comments', 'shares'];
const LABEL: Record<Key, string> = {
  views: 'Views',
  likes: 'Likes',
  comments: 'Comments',
  shares: 'Shares',
};

export function BeeStoriesView({ platform, range }: { platform: 'all' | 'fb' | 'ig'; range?: DateRange }) {
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
    .filter((s) => !range || inRange(s.date, range))
    .filter((s) => !q.trim() || s.headline.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => (sort === 'date' ? b.createdAt.localeCompare(a.createdAt) : sort === 'score' ? (score(b) ?? -1) - (score(a) ?? -1) : totals(b)[sort] - totals(a)[sort]));
  const sel = open ? (stories.find((s) => s.key === open) ?? null) : null;
  const scoreClass = (sc: number | null) => `bee-social__score bee-social__score--${sc == null ? '' : sc >= 90 ? 'top' : sc >= 65 ? 'above' : sc >= 35 ? 'typical' : 'below'}`;

  return (
    <>
      <div className="ally__txn-tools dash-card-tools">
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
      <div className="fin-dash__table-wrap post-table">
        <table className="fin-dash__table bee-posts bee-social__table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Story</th>
              <th>On</th>
              <th className="num">Score</th>
              {KEYS.map((k) => (
                <th key={k} className="num">
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
              return <StoryRow key={s.key} s={s} onOpen={() => setOpen(isOpen ? null : s.key)} t={t} sc={sc} />;
            })}
          </tbody>
        </table>
      </div>
      <ul className="post-cards">
        {list.slice(0, limit).map((s) => {
          const t = totals(s);
          const sc = score(s);
          return (
            <li key={s.key}>
              <button type="button" className="post-card" onClick={() => setOpen(s.key)}>
                <div className="post-card__top">
                  {s.parts.map((p) => (
                    <span key={p.platform} className={`bee-social__dot bee-social__dot--${p.platform}`} title={PLAT[p.platform]} />
                  ))}
                  {fmtDate(s.date)}
                  {s.mature ? <span className={scoreClass(sc)}>{sc ?? '—'}</span> : <span className="bee-badge bee-badge--muted">So Far</span>}
                </div>
                <div className="post-card__title">{s.headline}</div>
                <div className="post-card__metrics">
                  {KEYS.map((k) => (
                    <span key={k} className="post-card__metric">
                      <span className="post-card__metric-label">{LABEL[k]}</span>
                      <span className="post-card__metric-value">{n0(t[k])}</span>
                    </span>
                  ))}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
      {!list.length && <p className="fin-dash__muted">No stories in this range.</p>}
      {list.length > limit && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setLimit((l) => l + 50)}>
          Show More ({list.length - limit} left)
        </button>
      )}
      {sel && (
        <DetailSheet title={sel.headline} sub={`${fmtDate(sel.date)} · score ${score(sel) ?? '—'}`} onClose={() => setOpen(null)}>
          <StoryDetail s={sel} t={totals(sel)} withSubstack={withSubstack} />
        </DetailSheet>
      )}
    </>
  );
}

function StoryRow({ s, onOpen, t, sc }: { s: BeeStory; onOpen: () => void; t: BeeStory['total']; sc: number | null }) {
  return (
    <tr className="bee-social__row" onClick={onOpen}>
      <td className="bee-posts__date">{fmtDate(s.date)}</td>
      <td className="bee-posts__title">{s.headline}</td>
      <td className="bee-stories__on">
        {s.parts.map((p) => (
          <span key={p.platform} className={`bee-social__dot bee-social__dot--${p.platform}`} title={PLAT[p.platform]} />
        ))}
      </td>
      <td className="num">
        {s.mature ? (
          <span className={`bee-social__score bee-social__score--${sc == null ? '' : sc >= 90 ? 'top' : sc >= 65 ? 'above' : sc >= 35 ? 'typical' : 'below'}`}>{sc ?? '—'}</span>
        ) : (
          <span className="bee-badge bee-badge--muted">So Far</span>
        )}
      </td>
      {KEYS.map((k) => (
        <td key={k} className="num">
          {n0(t[k])}
        </td>
      ))}
    </tr>
  );
}

function StoryDetail({ s, t, withSubstack }: { s: BeeStory; t: BeeStory['total']; withSubstack: boolean }) {
  const parts = withSubstack ? s.parts : s.parts.filter((p) => p.platform !== 'substack');
  return (
    <div className="bee-scorecard">
      <div className="post-cards" style={{ display: 'block' }}>
        {parts.map((p) => (
          <PartCard key={p.platform} p={p} totalViews={t.views} />
        ))}
      </div>
      <div className="dash-split" style={{ marginTop: 12 }}>
        {KEYS.map((k) => (
          <div key={k} className="dash-split__item">
            <span className="fin-dash__stat-label">Total {LABEL[k]}</span>
            <span className="dash-split__value">{n0(t[k])}</span>
          </div>
        ))}
      </div>
      {(() => {
        const sub = s.parts.find((p) => p.platform === 'substack');
        return sub?.extra ? (
          <p className="fin-dash__muted">
            Substack: {n0(sub.extra.sent)} emailed · {n0(sub.extra.opened)} opened ({sub.extra.sent ? Math.round(((sub.extra.opened ?? 0) / sub.extra.sent) * 100) : 0}
            %) · {n0(sub.extra.signups)} free + {n0(sub.extra.paid)} paid subscribers gained
          </p>
        ) : null;
      })()}
      {s.parts.some((p) => p.platform === 'ig' && p.saves) && <p className="fin-dash__muted">Instagram saves: {n0(s.parts.find((p) => p.platform === 'ig')?.saves)}</p>}
    </div>
  );
}

function PartCard({ p, totalViews }: { p: BeeStoryPart; totalViews: number }) {
  return (
    <div className="post-card" style={{ cursor: 'default' }}>
      <div className="post-card__top">
        <span className={`bee-social__dot bee-social__dot--${p.platform}`} />
        {PLAT[p.platform]}
        {totalViews ? ` · ${Math.round(((p.views ?? 0) / totalViews) * 100)}% of views` : ''}
        {p.permalink && (
          <a href={p.permalink} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 'auto' }}>
            Open
          </a>
        )}
      </div>
      <div className="post-card__metrics" style={{ marginTop: 6 }}>
        {KEYS.map((k) => (
          <span key={k} className="post-card__metric">
            <span className="post-card__metric-label">{LABEL[k]}</span>
            <span className="post-card__metric-value">{n0(p[k])}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

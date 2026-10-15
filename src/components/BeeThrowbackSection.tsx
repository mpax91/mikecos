import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { BeeThrowback, BeeThrowbackCandidate } from '../api/types';
import { GradeChip } from './BeeGrade';
import { KebabMenu, type KebabMenuItem } from './KebabMenu';
import { SectionPicker } from './dash/SectionPicker';
import { DashTitle } from './dash/InfoTip';
import { copyText } from '../utils/clipboard';

/** Bee → Throwback (Mike, 2026-10-14): which older story to reshare on
 * Thursday. This Time Last Year / Best Of / History; Pick for Thursday,
 * Copy Facebook Post / Instagram Caption (with the 🕰️THROWBACK THURSDAY
 * prefix), Never Suggest. Ranking and reuse detection: worker/src/bee/throwback.ts. */

type Mode = 'seasonal' | 'best' | 'history';
const n0 = (n: number | null | undefined) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
const fmt = (d: string, year = true) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' });
const fmtThu = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const shiftWeek = (d: string, n: number) => new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 7 * 86400000).toISOString().slice(0, 10);
const pctBetter = (rank: number | null | undefined) => (rank == null ? null : `${Math.min(99, Math.round(rank))}%`);
const SOURCE: Record<string, string> = { prefix: 'Throwback', repurpose: 'Repurposed', manual: 'Marked', planned: 'Picked' };

function whenText(c: BeeThrowbackCandidate) {
  if (c.yearsAgo == null || c.daysOff == null) return fmt(c.date);
  const ago = c.yearsAgo === 1 ? '1 year ago' : `${c.yearsAgo} years ago`;
  const off = c.daysOff === 0 ? 'same day' : `${Math.abs(c.daysOff)} day${Math.abs(c.daysOff) === 1 ? '' : 's'} ${c.daysOff < 0 ? 'earlier' : 'later'}`;
  return `${fmt(c.date)} · ${ago}, ${off}`;
}

export function BeeThrowbackSection() {
  const [forDate, setForDate] = useState<string | undefined>(undefined);
  const [data, setData] = useState<BeeThrowback | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('seasonal');
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .getBeeThrowback(forDate)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [forDate]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  async function act(key: string, fn: () => Promise<unknown>, done: string) {
    setBusy(key);
    try {
      await fn();
      setToast(done);
      load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  }
  async function copy(text: string | null, what: string) {
    if (!text) return;
    setToast((await copyText(text)) ? `${what} copied — paste it into Meta Business Suite.` : 'Could not copy.');
  }

  if (error) return <p className="fin-dash__muted">{error}</p>;
  if (!data) return <p className="fin-dash__muted">Loading throwbacks…</p>;
  const target = data.target;
  const s = data.stats;

  const card = (c: BeeThrowbackCandidate) => {
    const fb = c.links.find((l) => l.platform === 'fb')?.url;
    const ig = c.links.find((l) => l.platform === 'ig')?.url;
    const picked = data.planned?.anchor === c.anchor;
    const items: KebabMenuItem[] = [
      ...(fb ? [{ label: 'Open on Facebook', onClick: () => window.open(fb, '_blank', 'noopener') }] : []),
      ...(ig ? [{ label: 'Open on Instagram', onClick: () => window.open(ig, '_blank', 'noopener') }] : []),
      { label: 'Mark as Reshared Today', onClick: () => act(c.anchor, () => api.addBeeThrowbackMark('manual', c.anchor), 'Marked as reshared today.'), separatorBefore: true },
      { label: 'Never Suggest', onClick: () => act(c.anchor, () => api.addBeeThrowbackMark('never', c.anchor), 'Won’t be suggested again (undo at the bottom).'), danger: true },
    ];
    return (
      <div key={c.anchor} className={`tbt-card${c.coolingUntil ? ' tbt-card--cooling' : ''}${picked ? ' tbt-card--picked' : ''}`}>
        <div className="tbt-card__head">
          <GradeChip grade={c.grade} />
          <div className="tbt-card__title">
            <div className="tbt-card__headline">{c.headline}</div>
            <div className="tbt-card__meta">{whenText(c)}</div>
          </div>
          <KebabMenu items={items} />
        </div>
        <div className="tbt-card__facts">
          <span>{n0(c.social.views)} views</span>
          <span>{n0(c.social.likes)} likes</span>
          <span>{n0(c.social.shares)} shares</span>
          {c.grade?.rank != null && <span>Better than {pctBetter(c.grade.rank)} of posts then</span>}
        </div>
        {c.newFollowers != null && c.newFollowers > 0 && (
          <div className="tbt-card__audience">
            ~{n0(c.newFollowers)} Facebook followers joined since{c.newShare != null ? ` — ${Math.round(c.newShare * 100)}% of today’s` : ''}
          </div>
        )}
        {c.uses.length > 0 && (
          <div className="tbt-card__uses">
            {c.coolingUntil ? `Sits out until ${fmt(c.coolingUntil)} · ` : ''}
            {c.uses[0].source === 'planned' ? 'Picked' : 'Reshared'} {c.uses.length === 1 ? 'once' : `${c.uses.length}×`} · last {fmt(c.uses[0].date)}
          </div>
        )}
        <div className="tbt-card__actions">
          {picked ? (
            <button type="button" className="btn btn--sm is-active" disabled>
              ✓ Picked for {fmtThu(target)}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy === c.anchor}
              onClick={() => act(c.anchor, () => api.addBeeThrowbackMark('planned', c.anchor, target), `Picked for ${fmtThu(target)}.`)}
            >
              Pick for {fmtThu(target)}
            </button>
          )}
          {c.fbText && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => copy(c.fbText, 'Facebook post')}>
              📋 Copy Facebook Post
            </button>
          )}
          {c.igText && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => copy(c.igText, 'Instagram caption')}>
              📋 Copy Instagram Caption
            </button>
          )}
        </div>
      </div>
    );
  };

  const raw = mode === 'seasonal' ? data.seasonal : data.best;
  // This Thursday's pick sits on top.
  const list = [...raw.filter((c) => c.anchor === data.planned?.anchor), ...raw.filter((c) => c.anchor !== data.planned?.anchor)];
  return (
    <div className="tbt">
      <div className="tbt__bar">
        <button type="button" className="btn btn--sm btn--ghost" aria-label="Previous week" onClick={() => setForDate(shiftWeek(target, -1))}>
          ‹
        </button>
        <span className="tbt__for">For {fmtThu(target)}</span>
        <button type="button" className="btn btn--sm btn--ghost" aria-label="Next week" onClick={() => setForDate(shiftWeek(target, 1))}>
          ›
        </button>
        {forDate && (
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setForDate(undefined)}>
            This Week
          </button>
        )}
        <Link to="/settings?cat=bee" className="settings-gear-link" title="Throwback Settings" aria-label="Throwback Settings">
          ⚙️
        </Link>
      </div>

      {data.planned && (
        <div className="tbt__picked">
          <span>
            ✓ Picked for {fmtThu(target)}: <strong>{data.planned.headline}</strong>
          </span>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => act('plan', () => api.deleteBeeThrowbackMark(data.planned!.markId), 'Pick removed.')}>
            Undo Pick
          </button>
        </div>
      )}

      <section className="fin-dash__card tbt__summary">
        <DashTitle
          info={
            <>
              <p>A post counts as reshared when its headline starts with 🕰️THROWBACK THURSDAY, or repeats an older headline almost word for word 30+ days later. Use a post’s ⋯ to mark one by hand.</p>
              <p>
                Grades are Facebook + Instagram combined, judged against the posts around each one when it ran — so early posts aren’t marked down for a smaller audience. A reshared story sits out{' '}
                {data.settings.cooldownDays} days.
              </p>
            </>
          }
        >
          Throwback Thursday
        </DashTitle>
        <div className="tbt__stats">
          <span>
            <strong>{s.reshares}</strong> reshared so far
          </span>
          {s.thursdayTbt.avgRank != null && s.thursdayOther.avgRank != null && (
            <span>
              Throwbacks beat <strong>{s.thursdayTbt.avgRank}%</strong> of posts on average · other Thursdays <strong>{s.thursdayOther.avgRank}%</strong>
            </span>
          )}
          {data.followersNow != null && (
            <span>
              <strong>{n0(data.followersNow)}</strong> Facebook followers today
            </span>
          )}
        </div>
      </section>

      <SectionPicker
        label="Throwback list"
        value={mode}
        onChange={setMode}
        options={[
          ['seasonal', 'This Time Last Year'],
          ['best', 'Best Of'],
          ['history', 'History'],
        ]}
      />

      {mode !== 'history' ? (
        <>
          <p className="fin-dash__muted tbt__count">
            {mode === 'seasonal'
              ? `${data.seasonalCount} stories within ${data.settings.windowDays} days of ${fmt(target, false)} in past years`
              : `${data.bestCount} stories at least ${Math.round(data.settings.minAgeDays / 30)} months old, best for newer followers first${data.coolingCount ? ` · ${data.coolingCount} sitting out after a reshare` : ''}`}
          </p>
          {list.length === 0 ? (
            <p className="fin-dash__muted">Nothing here yet{mode === 'seasonal' ? ' — try Best Of, or widen the window in Settings.' : '.'}</p>
          ) : (
            <div className="tbt__list">{list.map(card)}</div>
          )}
        </>
      ) : (
        <div className="tbt__list">
          {data.history.length === 0 && <p className="fin-dash__muted">No reshares found yet.</p>}
          {data.history.map((h) => (
            <div key={`${h.date}-${h.reuseAnchor ?? h.markId}`} className="tbt-hist">
              <div className="tbt-hist__date">
                {fmt(h.date)}
                <span className={`tbt-hist__src tbt-hist__src--${h.source}`}>{SOURCE[h.source]}</span>
              </div>
              <div className="tbt-hist__body">
                <div className="tbt-card__headline">{h.origHeadline}</div>
                <div className="tbt-card__meta">
                  {h.origDate ? `Original ${fmt(h.origDate)}` : ''}
                  {h.origGrade?.letter ? ` · ${h.origGrade.letter}` : ''}
                  {h.reuseGrade?.letter ? ` → reshare ${h.reuseGrade.letter}${h.reuseGrade.rank != null ? ` (beat ${pctBetter(h.reuseGrade.rank)})` : ''}` : ''}
                </div>
              </div>
              <KebabMenu
                items={
                  h.markId
                    ? [{ label: h.source === 'planned' ? 'Remove Pick' : 'Remove', onClick: () => act(h.markId!, () => api.deleteBeeThrowbackMark(h.markId!), 'Removed.'), danger: true }]
                    : [{ label: 'Not a Reshare', onClick: () => act(h.reuseAnchor!, () => api.addBeeThrowbackMark('not_reshare', h.reuseAnchor!), 'Got it — not counted as a reshare.'), danger: true }]
                }
              />
            </div>
          ))}
        </div>
      )}

      {data.hidden.length > 0 && (
        <details className="tbt__hidden">
          <summary>Never Suggest ({data.hidden.length})</summary>
          {data.hidden.map((h) => (
            <div key={h.markId} className="tbt__hidden-row">
              <span>{h.headline ?? h.anchor}</span>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => act(h.markId, () => api.deleteBeeThrowbackMark(h.markId), 'Back in the lists.')}>
                Unhide
              </button>
            </div>
          ))}
        </details>
      )}
      {toast && (
        <div className="tbt__toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

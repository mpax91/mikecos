import type { BeeGrade, BeeGradeDriver, BeeLetter } from '../api/types';

/** Post grades A–F (worker/src/bee/grades.ts) — chip, "why" line, filter
 * chips and the breakdown shown in a post's sheet. */

export const LETTERS: BeeLetter[] = ['A', 'B', 'C', 'D', 'F'];
const PCT_KEYS = new Set(['engagement', 'openRate', 'clickRate', 'unsubs']);

const ageText = (h: number) => (h < 1 ? 'under an hour' : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)} days`);

export const gradeRank = (g: BeeGrade | null | undefined) => (g?.letter ? (g.rank ?? -1) : -2);

export function GradeChip({ grade, size }: { grade: BeeGrade | null | undefined; size?: 'big' }) {
  if (!grade) return null;
  if (grade.tooEarly)
    return (
      <span className={`bee-grade bee-grade--new${size === 'big' ? ' bee-grade--big' : ''}`} title={`Too early to grade (${ageText(grade.ageHours)} old)`}>
        …
      </span>
    );
  if (!grade.letter)
    return (
      <span className="bee-grade bee-grade--new" title={grade.note ?? 'Not graded'}>
        –
      </span>
    );
  const title = [
    `Grade ${grade.letter}${grade.rank != null ? ` · better than ${Math.min(99, Math.round(grade.rank))}% of recent posts` : ''}`,
    grade.provisional ? `Provisional — ${ageText(grade.ageHours)} old, can still move` : null,
    grade.trend && grade.prevLetter ? `Was ${grade.prevLetter}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <span className="bee-grade-wrap" title={title}>
      <span className={`bee-grade bee-grade--${grade.letter.toLowerCase()}${grade.provisional ? ' bee-grade--prov' : ''}${size === 'big' ? ' bee-grade--big' : ''}`}>{grade.letter}</span>
      {grade.trend === 'up' && (
        <span className="bee-grade__trend bee-grade__trend--up" aria-label="rising">
          ↑
        </span>
      )}
      {grade.trend === 'down' && (
        <span className="bee-grade__trend bee-grade__trend--down" aria-label="falling">
          ↓
        </span>
      )}
    </span>
  );
}

/** One short reason: the best signal for A–C, the worst for D/F. */
export function gradeWhy(g: BeeGrade | null | undefined): string | null {
  if (!g || !g.letter) return null;
  return g.letter === 'D' || g.letter === 'F' ? (g.worst ?? g.best) : (g.best ?? g.worst);
}
export function GradeWhy({ grade }: { grade: BeeGrade | null | undefined }) {
  const w = gradeWhy(grade);
  if (!w) return null;
  const bad = grade?.letter === 'D' || grade?.letter === 'F';
  return <span className={`bee-grade__why${bad ? ' bee-grade__why--bad' : ''}`}>{w}</span>;
}

export function GradeFilter({ grades, value, onChange }: { grades: (BeeGrade | null | undefined)[]; value: BeeLetter | 'pending' | null; onChange: (v: BeeLetter | 'pending' | null) => void }) {
  const n = (l: BeeLetter) => grades.filter((g) => g?.letter === l).length;
  const pending = grades.filter((g) => g?.tooEarly).length;
  if (!grades.some((g) => g?.letter)) return null;
  return (
    <div className="bee-grades" role="group" aria-label="Filter by grade">
      {LETTERS.map((l) => (
        <button key={l} type="button" className={`bee-grades__chip bee-grade--${l.toLowerCase()}${value === l ? ' is-active' : ''}`} onClick={() => onChange(value === l ? null : l)}>
          <span className="bee-grades__letter">{l}</span>
          <span className="bee-grades__n">{n(l)}</span>
        </button>
      ))}
      {pending > 0 && (
        <button type="button" className={`bee-grades__chip bee-grade--new${value === 'pending' ? ' is-active' : ''}`} onClick={() => onChange(value === 'pending' ? null : 'pending')}>
          <span className="bee-grades__letter">Too Early</span>
          <span className="bee-grades__n">{pending}</span>
        </button>
      )}
    </div>
  );
}
export const matchesGrade = (g: BeeGrade | null | undefined, f: BeeLetter | 'pending' | null) => !f || (f === 'pending' ? !!g?.tooEarly : g?.letter === f);

function fmtVal(d: BeeGradeDriver, v: number | null) {
  if (v == null) return '—';
  if (PCT_KEYS.has(d.key)) return `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
  if (d.key === 'forwards') return `${v.toFixed(2)}×`;
  if (Math.abs(v) >= 10000) return `${(v / 1000).toFixed(0)}K`;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** The grade explained: letter, rank, provisional state and every signal. */
export function GradeBreakdown({ grade, title = 'Grade', storyParts }: { grade: BeeGrade | null | undefined; title?: string; storyParts?: boolean }) {
  if (!grade) return null;
  const totalW = grade.drivers.reduce((n, d) => n + d.weight, 0) || 1;
  return (
    <div className="bee-gradecard">
      <div className="bee-gradecard__head">
        <GradeChip grade={grade} size="big" />
        <div>
          <strong>{title}</strong>
          <div className="fin-dash__muted">
            {grade.tooEarly
              ? `Too early to grade — ${ageText(grade.ageHours)} old.`
              : grade.letter
                ? `Better than ${Math.min(99, Math.round(grade.rank ?? 0))}% of recent posts${grade.baselineN ? ` (vs ${grade.baselineN})` : ''}.`
                : (grade.note ?? 'Not graded.')}
          </div>
          {grade.letter && grade.provisional && (
            <div className="fin-dash__muted">
              Provisional · {ageText(grade.ageHours)} old{grade.projected ? ' · numbers projected from how past posts grew' : ''} · {grade.confidence} confidence
            </div>
          )}
          {grade.trend && grade.prevLetter && (
            <div className="fin-dash__muted">
              {grade.trend === 'up' ? '↑ Rising' : grade.trend === 'down' ? '↓ Falling' : 'Holding'} — was {grade.prevLetter}
            </div>
          )}
          {grade.note && grade.letter && <div className="fin-dash__muted">{grade.note}</div>}
        </div>
      </div>
      {(grade.best || grade.worst) && (
        <div className="bee-badges">
          {grade.best && <span className="bee-badge bee-badge--good">▲ {grade.best}</span>}
          {grade.worst && <span className="bee-badge bee-badge--bad">▼ {grade.worst}</span>}
        </div>
      )}
      {grade.drivers.length > 0 && (
        <ul className="bee-gradecard__drivers">
          {grade.drivers.map((d) => (
            <li key={d.key}>
              <span className="bee-gradecard__label">
                {d.label} <span className="fin-dash__muted">· {Math.round((d.weight / totalW) * 100)}%</span>
              </span>
              <span className="bee-gradecard__bar" aria-hidden="true">
                <span style={{ width: `${Math.max(2, d.pct)}%` }} className={d.pct >= 65 ? 'is-good' : d.pct <= 35 ? 'is-bad' : ''} />
              </span>
              <span className="bee-gradecard__val">
                {storyParts ? (
                  d.value != null ? (
                    `${Math.round(d.value)}th pct`
                  ) : (
                    '—'
                  )
                ) : (
                  <>
                    {fmtVal(d, d.value)}
                    <span className="fin-dash__muted"> vs {fmtVal(d, d.typical)}</span>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {grade.history && grade.history.length > 1 && (
        <p className="fin-dash__muted bee-gradecard__history">
          So far:{' '}
          {grade.history.map((h, i) => (
            <span key={h.at}>
              {i > 0 && ' → '}
              {h.letter ?? '…'}
            </span>
          ))}
          {grade.letter ? ` → ${grade.letter} now` : ''}
        </p>
      )}
    </div>
  );
}

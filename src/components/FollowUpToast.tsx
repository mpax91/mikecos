import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Entity } from '../api/types';
import { onTaskCompleted } from '../utils/taskEvents';

/** Waiting For toast (Mike, 2026-10-08). Every time a task is checked off,
 * a toast offers "Follow up in 7 days" — − / + change the days (hold to
 * repeat). Ignore it and it slides away; it stays put while the pointer or
 * focus is on it. "Remind Me" creates a "Check Back: …" task due that day
 * (Plan → Waiting For lists them), with Undo. Mounted once in App. */

const DEFAULT_DAYS = 7;
const VISIBLE_MS = 12000;
const CONFIRM_MS = 6000;
const PREFIX = 'Check Back: ';

const addDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
};
const fmtDay = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const daysLabel = (n: number) => (n === 7 ? '1 week' : n === 14 ? '2 weeks' : n === 1 ? '1 day' : `${n} days`);

type State = { phase: 'offer'; task: Entity } | { phase: 'saved'; task: Entity; followUp: Entity; due: Date } | null;

export function FollowUpToast() {
  const [state, setState] = useState<State>(null);
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [busy, setBusy] = useState(false);
  const [hold, setHold] = useState(false); // pointer/focus inside → don't auto-dismiss
  const [tick, setTick] = useState(0); // restarts the timer after each interaction
  const repeat = useRef<{ t?: ReturnType<typeof setTimeout>; i?: ReturnType<typeof setInterval> }>({});

  useEffect(
    () =>
      onTaskCompleted((task) => {
        setDays(DEFAULT_DAYS);
        setBusy(false);
        setState({ phase: 'offer', task });
        setTick((t) => t + 1);
      }),
    []
  );

  const close = useCallback(() => setState(null), []);

  useEffect(() => {
    if (!state || hold) return;
    const t = setTimeout(close, state.phase === 'offer' ? VISIBLE_MS : CONFIRM_MS);
    return () => clearTimeout(t);
  }, [state, hold, tick, close]);

  const step = (delta: number) => {
    setDays((d) => Math.max(1, Math.min(365, d + delta)));
    setTick((t) => t + 1);
  };
  const startRepeat = (delta: number) => {
    step(delta);
    repeat.current.t = setTimeout(() => {
      repeat.current.i = setInterval(() => step(delta), 90);
    }, 400);
  };
  const stopRepeat = () => {
    clearTimeout(repeat.current.t);
    clearInterval(repeat.current.i);
  };
  useEffect(() => stopRepeat, []);

  async function remind() {
    if (!state || state.phase !== 'offer') return;
    setBusy(true);
    try {
      const followUp = await api.createFollowUp(state.task.id, { days });
      setState({ phase: 'saved', task: state.task, followUp, due: addDays(days) });
      setTick((t) => t + 1);
    } catch {
      setBusy(false);
    }
  }

  async function undo() {
    if (!state || state.phase !== 'saved') return;
    await api.deleteEntity(state.followUp.id).catch(() => {});
    close();
  }

  if (!state) return null;
  const title = state.task.title?.startsWith(PREFIX) ? state.task.title.slice(PREFIX.length) : state.task.title || 'Task';
  const isCheckBack = !!state.task.waiting_source_id;

  return (
    <div
      className="toast follow-toast"
      role="status"
      onPointerEnter={() => setHold(true)}
      onPointerLeave={() => {
        setHold(false);
        stopRepeat();
      }}
      onFocus={() => setHold(true)}
      onBlur={() => setHold(false)}
    >
      {state.phase === 'offer' ? (
        <>
          <span className="follow-toast__msg">
            <span className="follow-toast__check">✓</span>
            <span className="follow-toast__title">{isCheckBack ? `Still waiting on “${title}”?` : title}</span>
          </span>
          <span className="follow-toast__controls">
            <span className="follow-toast__label">Follow up in</span>
            <button
              type="button"
              className="follow-toast__step"
              aria-label="One day sooner"
              disabled={days <= 1}
              onPointerDown={() => startRepeat(-1)}
              onPointerUp={stopRepeat}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), step(-1))}
            >
              −
            </button>
            <span className="follow-toast__days" title={fmtDay(addDays(days))}>
              {daysLabel(days)}
              <span className="follow-toast__date">{fmtDay(addDays(days))}</span>
            </span>
            <button
              type="button"
              className="follow-toast__step"
              aria-label="One day later"
              onPointerDown={() => startRepeat(1)}
              onPointerUp={stopRepeat}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), step(1))}
            >
              +
            </button>
            <button type="button" className="toast__action follow-toast__go" disabled={busy} onClick={remind}>
              Remind Me
            </button>
          </span>
        </>
      ) : (
        <>
          <span className="follow-toast__msg">
            <span className="follow-toast__check">⏳</span>
            <span className="follow-toast__title">
              Check back {fmtDay(state.due)} ·{' '}
              <Link to="/waiting" className="follow-toast__link" onClick={close}>
                Waiting For
              </Link>
            </span>
          </span>
          <button type="button" className="toast__action" onClick={undo}>
            Undo
          </button>
        </>
      )}
      <button type="button" className="toast__close" onClick={close} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}

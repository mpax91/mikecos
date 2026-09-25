import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { HabitEvent, HabitSummary } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';
import { habitHeadline, habitTrendStreak } from '../utils/habits';
import { Modal } from '../components/Modal';
import { HabitSparkline } from '../components/HabitSparkline';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function HabitDetailModal({ summary, onClose, onChanged }: { summary: HabitSummary; onClose: () => void; onChanged: () => void }) {
  const habit = summary.habit;
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const [events, setEvents] = useState<HabitEvent[] | null>(null);
  const [customValue, setCustomValue] = useState('');

  function load() {
    api.listHabitEvents(habit.id, todayIso).then(setEvents);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [habit.id]);

  async function logTap(value?: number) {
    await api.logHabitEvent(habit.id, value);
    load();
    onChanged();
  }

  async function undo(eventId: string) {
    setEvents((prev) => (prev ? prev.filter((e) => e.id !== eventId) : prev));
    await api.deleteHabitEvent(habit.id, eventId);
    onChanged();
  }

  const headline = habitHeadline(summary);
  const streak = habitTrendStreak(summary);

  return (
    <Modal title={`${habit.icon ? `${habit.icon} ` : ''}${habit.name}`} onClose={onClose}>
      <div className={`habits-page__detail-headline habits-page__detail-headline--${headline.tone}`}>{headline.text}</div>
      {streak >= 2 && <div className="habits-page__detail-streak">🔥 {streak}-day improving streak</div>}

      <div className="habits-page__detail-stats">
        <div>
          <div className="habits-page__detail-stat-value">{summary.today}</div>
          <div className="habits-page__detail-stat-label">Today</div>
        </div>
        <div>
          <div className="habits-page__detail-stat-value">{summary.avg7.toFixed(1)}</div>
          <div className="habits-page__detail-stat-label">7-day avg</div>
        </div>
        <div>
          <div className="habits-page__detail-stat-value">{summary.avg30.toFixed(1)}</div>
          <div className="habits-page__detail-stat-label">30-day avg</div>
        </div>
        {summary.best !== null && (
          <div>
            <div className="habits-page__detail-stat-value">{summary.best}</div>
            <div className="habits-page__detail-stat-label">Best day</div>
          </div>
        )}
      </div>

      <div className="habits-page__detail-log-actions">
        <button className="btn" onClick={() => logTap()}>
          + Log one now
        </button>
        <input
          type="number"
          placeholder="Custom amount"
          value={customValue}
          onChange={(e) => setCustomValue(e.target.value)}
        />
        <button
          className="btn btn--ghost"
          disabled={!customValue.trim()}
          onClick={() => {
            const n = Number(customValue);
            if (!Number.isNaN(n)) logTap(n);
            setCustomValue('');
          }}
        >
          Add
        </button>
      </div>

      <div className="habits-page__detail-events-label">Today's log{habit.unit ? ` (${habit.unit})` : ''}</div>
      {events === null ? (
        <div className="empty-state">Loading…</div>
      ) : events.length === 0 ? (
        <div className="empty-state">Nothing logged yet today.</div>
      ) : (
        <div className="habits-page__detail-events">
          {events.map((e) => (
            <div className="habits-page__detail-event" key={e.id}>
              <span>{formatTime(e.occurred_at)}</span>
              <span>{e.value}{habit.unit ? ` ${habit.unit}` : ''}</span>
              <button type="button" onClick={() => undo(e.id)} title="Undo this entry">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function HabitTile({ summary, onLogged, onOpenDetail }: { summary: HabitSummary; onLogged: () => void; onOpenDetail: () => void }) {
  const habit = summary.habit;
  const [logging, setLogging] = useState(false);
  const headline = habitHeadline(summary);

  async function tap(e: React.MouseEvent) {
    e.stopPropagation();
    setLogging(true);
    try {
      await api.logHabitEvent(habit.id);
      onLogged();
    } finally {
      setLogging(false);
    }
  }

  return (
    <div className="habits-page__tile" onClick={onOpenDetail}>
      <div className="habits-page__tile-top">
        <div className="habits-page__tile-name">
          {habit.icon ? <span className="habits-page__tile-icon">{habit.icon}</span> : null}
          {habit.name}
        </div>
        <HabitSparkline summary={summary} />
      </div>
      <div className="habits-page__tile-count">
        {summary.today}
        {habit.unit && <span className="habits-page__tile-unit">{habit.unit}</span>}
      </div>
      <div className={`habits-page__tile-headline habits-page__tile-headline--${headline.tone}`}>{headline.text}</div>
      <button type="button" className="habits-page__tile-tap" onClick={tap} disabled={logging}>
        + Log one
      </button>
    </div>
  );
}

export function HabitsPage() {
  useReportTabMeta('Habits', 'habits');
  const [summaries, setSummaries] = useState<HabitSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<HabitSummary | null>(null);

  function load() {
    api
      .getHabitsSummary()
      .then((res) => {
        setSummaries(res);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    load();
  }, []);

  if (error) return <div className="empty-state">Couldn't load habits: {error}</div>;
  if (!summaries) return <div className="empty-state">Loading…</div>;

  return (
    <div className="habits-page">
      <div className="toolbar-row">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
          Habits
        </h1>
        <Link to="/settings?cat=habits" className="btn btn--ghost">
          Manage Habits
        </Link>
      </div>

      {summaries.length === 0 ? (
        <div className="empty-state">
          No habits set up yet. <Link to="/settings?cat=habits">Add your first one in Settings</Link>.
        </div>
      ) : (
        <div className="habits-page__grid">
          {summaries.map((s) => (
            <HabitTile
              key={s.habit.id}
              summary={s}
              onLogged={load}
              onOpenDetail={() => setDetail(s)}
            />
          ))}
        </div>
      )}

      {detail && (() => {
        const latest = summaries.find((s) => s.habit.id === detail.habit.id) ?? detail;
        return <HabitDetailModal summary={latest} onClose={() => setDetail(null)} onChanged={load} />;
      })()}
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { HealthWeeklyReport } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';

type LifeArea = 'fitness' | 'finance' | 'vehicle';

const LIFE_AREAS: { id: LifeArea; label: string; icon: string; available: boolean }[] = [
  { id: 'fitness', label: 'Fitness', icon: '🩺', available: true },
  { id: 'finance', label: 'Finance', icon: '💰', available: false },
  { id: 'vehicle', label: 'Vehicle', icon: '🚗', available: false },
];

function formatWeekRange(start: string, end: string): string {
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(s)} – ${fmt(e)}`;
}

function shortLabel(weekStart: string): string {
  const d = new Date(`${weekStart}T00:00:00`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Looks back from `weeks[idx]` for the most recent earlier week that has a
 * non-null value for `field`, so a delta skips cleanly over a gap (missing
 * data) instead of comparing against a week that wasn't really tracked —
 * the same problem Google's own "vs last week" text has, which is why
 * deltas are computed here rather than trusted from the source. */
function deltaFrom<K extends keyof HealthWeeklyReport>(weeks: HealthWeeklyReport[], idx: number, field: K): number | null {
  const current = weeks[idx][field];
  if (current == null) return null;
  for (let i = idx - 1; i >= 0; i--) {
    const prior = weeks[i][field];
    if (prior != null) return (current as number) - (prior as number);
  }
  return null;
}

function DeltaBadge({ value, unit = '', invert = false }: { value: number | null; unit?: string; invert?: boolean }) {
  if (value === null || value === 0) return null;
  const good = invert ? value < 0 : value > 0;
  const sign = value > 0 ? '+' : '';
  return (
    <span className={`dashboard-page__tile-delta${good ? ' is-up' : ' is-down'}`}>
      {sign}
      {typeof value === 'number' && Number.isInteger(value) ? value : value.toFixed(1)}
      {unit}
    </span>
  );
}

function Tile({
  label,
  value,
  delta,
}: {
  label: string;
  value: string | null;
  delta?: React.ReactNode;
}) {
  return (
    <div className="dashboard-page__tile card">
      <div className="dashboard-page__tile-label">{label}</div>
      <div className="dashboard-page__tile-value">{value ?? <span className="dashboard-page__tile-nodata">No data</span>}</div>
      {delta}
    </div>
  );
}

/** A hand-rolled bar chart (no new charting dependency — same approach as
 * StatsPage's "Last 14 Days" strip) scaled to the visible weeks' own
 * min/max rather than starting at zero, since a metric like weight or
 * resting heart rate is only meaningfully different within a narrow band
 * — a zero-based bar would make every week look identical. */
function TrendChart({ title, weeks, field, unit, decimals = 0 }: { title: string; weeks: HealthWeeklyReport[]; field: keyof HealthWeeklyReport; unit: string; decimals?: number }) {
  const values = weeks.map((w) => w[field] as number | null);
  const present = values.filter((v): v is number => v != null);
  if (present.length === 0) {
    return (
      <div className="dashboard-page__chart card">
        <div className="dashboard-page__chart-title">{title}</div>
        <div className="empty-state">No data yet for this metric.</div>
      </div>
    );
  }
  const min = Math.min(...present);
  const max = Math.max(...present);
  const range = max - min || 1;

  return (
    <div className="dashboard-page__chart card">
      <div className="dashboard-page__chart-title">{title}</div>
      <div className="dashboard-page__chart-bars">
        {weeks.map((w, i) => {
          const v = values[i];
          const pct = v == null ? 0 : 12 + ((v - min) / range) * 88; // floor at 12% so a present-but-low value still shows a sliver
          return (
            <div key={w.week_start} className="dashboard-page__chart-col" title={v == null ? `${shortLabel(w.week_start)}: no data` : `${shortLabel(w.week_start)}: ${v.toFixed(decimals)}${unit}`}>
              <div className="dashboard-page__chart-count">{v == null ? '' : v.toFixed(decimals)}</div>
              <div className={`dashboard-page__chart-bar${v == null ? ' is-empty' : ''}`} style={{ height: `${v == null ? 3 : pct}%` }} />
              <div className="dashboard-page__chart-date">{shortLabel(w.week_start)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FitnessDashboard() {
  const [weeks, setWeeks] = useState<HealthWeeklyReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listHealthWeekly()
      .then(setWeeks)
      .catch((e) => setError(String(e)));
  }, []);

  const recent = useMemo(() => (weeks ? weeks.slice(-14) : []), [weeks]);
  const current = weeks && weeks.length > 0 ? weeks[weeks.length - 1] : null;
  const currentIdx = weeks ? weeks.length - 1 : -1;

  if (error) return <div className="empty-state">Couldn't load health data: {error}</div>;
  if (!weeks) return <div className="empty-state">Loading…</div>;
  if (weeks.length === 0) {
    return (
      <div className="empty-state">
        No health data yet — upload a Google Health weekly report from Settings → Health Import to get started.
      </div>
    );
  }

  return (
    <div>
      {current && (
        <>
          <div className="dashboard-page__section-title">Current Week · {formatWeekRange(current.week_start, current.week_end)}</div>
          <div className="dashboard-page__tiles">
            <Tile
              label="Steps"
              value={current.total_steps != null ? current.total_steps.toLocaleString() : null}
              delta={<DeltaBadge value={deltaFrom(weeks, currentIdx, 'total_steps')} />}
            />
            <Tile
              label="Best Day"
              value={current.best_day_steps != null ? `${current.best_day_steps.toLocaleString()}${current.best_day_weekday ? ` (${current.best_day_weekday})` : ''}` : null}
            />
            <Tile label="Miles" value={current.total_miles != null ? current.total_miles.toFixed(2) : null} delta={<DeltaBadge value={deltaFrom(weeks, currentIdx, 'total_miles')} unit=" mi" />} />
            <Tile label="Floors" value={current.total_floors != null ? String(current.total_floors) : null} />
            <Tile label="Calories Burned" value={current.avg_calories_burned != null ? current.avg_calories_burned.toLocaleString() : null} />
            <Tile
              label="Active Zone Minutes"
              value={current.avg_active_zone_minutes != null ? String(current.avg_active_zone_minutes) : null}
              delta={<DeltaBadge value={deltaFrom(weeks, currentIdx, 'avg_active_zone_minutes')} unit=" min" />}
            />
            <Tile
              label="Restful Sleep"
              value={current.avg_restful_sleep_minutes != null ? `${Math.floor(current.avg_restful_sleep_minutes / 60)}h ${current.avg_restful_sleep_minutes % 60}m` : null}
            />
            <Tile
              label="Resting Heart Rate"
              value={current.avg_resting_heart_rate != null ? `${current.avg_resting_heart_rate} bpm` : null}
              delta={<DeltaBadge value={deltaFrom(weeks, currentIdx, 'avg_resting_heart_rate')} unit=" bpm" invert />}
            />
            <Tile
              label="Weight"
              value={current.avg_weight_lb != null ? `${current.avg_weight_lb.toFixed(1)} lb` : null}
              delta={<DeltaBadge value={deltaFrom(weeks, currentIdx, 'avg_weight_lb')} unit=" lb" invert />}
            />
          </div>
        </>
      )}

      <div className="dashboard-page__section-title" style={{ marginTop: 28 }}>
        Trends {recent.length < weeks.length ? `· Last ${recent.length} Weeks` : ''}
      </div>
      <div className="dashboard-page__charts">
        <TrendChart title="Steps / Week" weeks={recent} field="total_steps" unit="" />
        <TrendChart title="Weight (lb)" weeks={recent} field="avg_weight_lb" unit=" lb" decimals={1} />
        <TrendChart title="Resting Heart Rate (bpm)" weeks={recent} field="avg_resting_heart_rate" unit=" bpm" />
        <TrendChart title="Restful Sleep (hrs)" weeks={recent} field="avg_restful_sleep_minutes" unit="h" decimals={1} />
      </div>

      <p className="settings-page__section-hint" style={{ marginTop: 16 }}>
        Weeks with no bar (or "No data") are weeks the tracker wasn't worn — heart rate, sleep, and active zone
        minutes can't be a real zero for a whole week, so those come through blank rather than as misleading zeros.
        Weight can stay flat for several weeks in a row if there wasn't a new scale reading — Google Health appears
        to carry the last known weight forward rather than leaving it blank.
      </p>
    </div>
  );
}

export function DashboardPage() {
  useReportTabMeta('Dashboard', 'dashboard');
  const [area, setArea] = useState<LifeArea>('fitness');

  return (
    <div>
      <div className="toolbar-row">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
          Dashboard
        </h1>
        <select
          className="dashboard-page__area-select"
          value={area}
          onChange={(e) => setArea(e.target.value as LifeArea)}
        >
          {LIFE_AREAS.map((a) => (
            <option key={a.id} value={a.id} disabled={!a.available}>
              {a.icon} {a.label}
              {!a.available ? ' (coming later)' : ''}
            </option>
          ))}
        </select>
      </div>

      {area === 'fitness' && <FitnessDashboard />}
      {area !== 'fitness' && (
        <div className="empty-state">
          {LIFE_AREAS.find((a) => a.id === area)?.label} isn't built yet — Fitness is the first life area wired up
          here; this dropdown is where the rest (Finance, Vehicle, and anything else) will live as they're added.
        </div>
      )}
    </div>
  );
}

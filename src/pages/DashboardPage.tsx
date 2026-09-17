import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type { HealthWeeklyReport } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';
import { buildPeriods, periodDeltaWithRef, type AggregatedPeriod, type Granularity } from '../utils/healthPeriods';

type LifeArea = 'fitness' | 'finance' | 'vehicle';

const LIFE_AREAS: { id: LifeArea; label: string; icon: string; available: boolean }[] = [
  { id: 'fitness', label: 'Fitness', icon: '🩺', available: true },
  { id: 'finance', label: 'Finance', icon: '💰', available: false },
  { id: 'vehicle', label: 'Vehicle', icon: '🚗', available: false },
];

const GRANULARITIES: { id: Granularity; label: string }[] = [
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'quarter', label: 'Quarter' },
  { id: 'year', label: 'Year' },
];

type MetricKey = 'steps' | 'miles' | 'calories' | 'azm' | 'sleep' | 'heartRate' | 'weight';

interface MetricConfig {
  label: string;
  invert?: boolean; // true when a decrease is the "good" direction (heart rate, weight)
  // Floor for the trend chart's min/max scale, in the metric's own units.
  // Weight and resting heart rate barely move week to week — a real ~3lb
  // change can span nearly the whole chart height if the scale hugs the
  // data's actual min/max, making an ordinary fluctuation look like a
  // cliff. Padding the scale out to at least this wide (centered on the
  // data) keeps a small real change looking small.
  minRange?: number;
  get: (p: AggregatedPeriod) => number | null;
  formatTile: (v: number) => string;
}

const METRICS: Record<MetricKey, MetricConfig> = {
  steps: {
    label: 'Steps',
    get: (p) => p.totalSteps,
    formatTile: (v) => v.toLocaleString(),
  },
  miles: {
    label: 'Miles',
    get: (p) => p.totalMiles,
    formatTile: (v) => v.toFixed(2),
  },
  calories: {
    label: 'Calories Burned (avg/day)',
    get: (p) => p.avgCaloriesBurned,
    formatTile: (v) => Math.round(v).toLocaleString(),
  },
  azm: {
    label: 'Active Zone Minutes',
    get: (p) => p.avgActiveZoneMinutes,
    formatTile: (v) => String(Math.round(v)),
  },
  sleep: {
    label: 'Restful Sleep (avg/night)',
    get: (p) => p.avgRestfulSleepMinutes,
    formatTile: (v) => `${Math.floor(v / 60)}h ${Math.round(v % 60)}m`,
  },
  heartRate: {
    label: 'Resting Heart Rate',
    invert: true,
    minRange: 15,
    get: (p) => p.avgRestingHeartRate,
    formatTile: (v) => `${Math.round(v)} bpm`,
  },
  weight: {
    label: 'Weight',
    invert: true,
    minRange: 10,
    get: (p) => p.avgWeightLb,
    formatTile: (v) => `${v.toFixed(1)} lb`,
  },
};

function DeltaBadge({ value, unit = '', invert = false, refLabel }: { value: number | null; unit?: string; invert?: boolean; refLabel?: string }) {
  if (value === null || Math.abs(value) < 0.05) return null;
  const good = invert ? value < 0 : value > 0;
  const sign = value > 0 ? '+' : '';
  return (
    <span className={`dashboard-page__tile-delta${good ? ' is-up' : ' is-down'}`} title={refLabel ? `vs ${refLabel}` : undefined}>
      {sign}
      {Number.isInteger(value) ? value : value.toFixed(1)}
      {unit}
    </span>
  );
}

/** Tiny inline trend, drawn straight into the tile so a number never sits
 * alone — the same instinct behind Analytics-style dashboards showing a
 * sparkline next to every metric. Scaled to its own min/max (not zero),
 * same reasoning as the big trend chart below. */
function Sparkline({ values }: { values: (number | null)[] }) {
  const present = values.filter((v): v is number => v != null);
  if (present.length < 2) return null;
  const min = Math.min(...present);
  const max = Math.max(...present);
  const range = max - min || 1;
  const w = 100;
  const h = 28;
  const step = w / (values.length - 1);
  const points: string[] = [];
  values.forEach((v, i) => {
    if (v == null) return;
    const x = i * step;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    points.push(`${x},${y}`);
  });
  return (
    <svg className="dashboard-page__sparkline" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline points={points.join(' ')} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Tile({
  label,
  value,
  aside,
  delta,
  sparkline,
  active,
  onClick,
}: {
  label: string;
  value: string | null;
  aside?: string | null;
  delta?: React.ReactNode;
  sparkline?: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`dashboard-page__tile card${onClick ? ' is-clickable' : ''}${active ? ' is-active' : ''}`} onClick={onClick}>
      <div className="dashboard-page__tile-label">{label}</div>
      <div className="dashboard-page__tile-value">{value ?? <span className="dashboard-page__tile-nodata">No data</span>}</div>
      {aside && <div className="dashboard-page__tile-aside">{aside}</div>}
      <div className="dashboard-page__tile-footer">
        {delta}
        {sparkline}
      </div>
    </Tag>
  );
}

/** The big trend chart for whichever metric is selected — a hand-rolled bar
 * chart (no new charting dependency, same approach as StatsPage's own
 * trend strip) scaled to the visible periods' own min/max rather than zero,
 * since weight/heart-rate only vary within a narrow band. */
function TrendChart({ config, periods, currentIndex }: { config: MetricConfig; periods: AggregatedPeriod[]; currentIndex: number }) {
  const currentBarRef = useRef<HTMLDivElement>(null);

  // The chart always shows every period there is — Prev/Next in the pill
  // above just moves which bar is highlighted (see the component doc
  // comment on FitnessDashboard). So instead of resizing the window to
  // keep the pill's period on screen, scroll the highlighted bar into view
  // whenever it changes.
  useEffect(() => {
    currentBarRef.current?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [currentIndex, periods]);

  const values = periods.map((p) => config.get(p));
  const present = values.filter((v): v is number => v != null);
  if (present.length === 0) {
    return <div className="empty-state">No data yet for {config.label.toLowerCase()}.</div>;
  }
  const dataMin = Math.min(...present);
  const dataMax = Math.max(...present);
  const avg = present.reduce((a, b) => a + b, 0) / present.length;
  const selectedValue = values[currentIndex];

  // Widen the scale symmetrically to at least minRange when the metric
  // configures one — see MetricConfig's comment on why (weight/heart rate
  // otherwise turn a couple-pound wobble into what looks like a cliff).
  const dataRange = dataMax - dataMin;
  const pad = config.minRange && config.minRange > dataRange ? (config.minRange - dataRange) / 2 : 0;
  const min = dataMin - pad;
  const max = dataMax + pad;
  const range = max - min || 1;

  return (
    <div>
      <div className="dashboard-page__trend-range">
        {periods[0].shortLabel} – {periods[periods.length - 1].shortLabel}
        {periods.length > 1 ? ` · all ${periods.length} periods` : ''}
      </div>
      <div className="dashboard-page__trend-stats">
        <div>
          <span className="dashboard-page__trend-stat-label">Selected</span>
          <span className="dashboard-page__trend-stat-value">{selectedValue != null ? config.formatTile(selectedValue) : '—'}</span>
        </div>
        <div>
          <span className="dashboard-page__trend-stat-label">Average</span>
          <span className="dashboard-page__trend-stat-value">{config.formatTile(avg)}</span>
        </div>
        <div>
          <span className="dashboard-page__trend-stat-label">Low</span>
          <span className="dashboard-page__trend-stat-value">{config.formatTile(dataMin)}</span>
        </div>
        <div>
          <span className="dashboard-page__trend-stat-label">High</span>
          <span className="dashboard-page__trend-stat-value">{config.formatTile(dataMax)}</span>
        </div>
      </div>
      <div className="dashboard-page__chart-scroll">
        <div className={`dashboard-page__chart-bars dashboard-page__chart-bars--large${periods.length > 16 ? ' is-dense' : ''}`}>
          {periods.map((p, i) => {
            const v = values[i];
            const pct = v == null ? 0 : 10 + ((v - min) / range) * 90;
            return (
              <div
                key={p.key}
                ref={i === currentIndex ? currentBarRef : undefined}
                className={`dashboard-page__chart-col${i === currentIndex ? ' is-current' : ''}`}
                title={v == null ? `${p.shortLabel}: no data` : `${p.label}: ${config.formatTile(v)}`}
              >
                <div className="dashboard-page__chart-count">{v == null ? '' : config.formatTile(v)}</div>
                <div className={`dashboard-page__chart-bar${v == null ? ' is-empty' : ''}`} style={{ height: `${v == null ? 3 : pct}%` }} />
                <div className="dashboard-page__chart-date">{p.shortLabel}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function weekdayDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return `${WEEKDAY_SHORT[d.getDay()]}, ${shortDate(iso)}`;
}

/** Main + secondary label for the period nav. Weeks get a "Week of Sep 5"
 * headline (cleaner than a raw ISO date range) plus the exact Sat–Fri span
 * underneath — Google Health's own reporting week runs Saturday through
 * Friday for every one of Mike's 16 samples, not the Sunday-start a glance
 * at the ISO dates suggests, so spelling out the weekdays here answers
 * "why does this look off by a day or two" instead of leaving it implicit. */
function periodLabels(period: AggregatedPeriod, granularity: Granularity): { main: string; sub: string | null } {
  if (granularity === 'week') {
    return { main: `Week of ${shortDate(period.start)}`, sub: `${weekdayDate(period.start)} – ${weekdayDate(period.end)}` };
  }
  const sub = period.weekCount > 0 ? `${period.weeksWithData} of ${period.weekCount} week${period.weekCount === 1 ? '' : 's'} tracked` : null;
  return { main: period.label, sub };
}

function FitnessDashboard() {
  const [weeks, setWeeks] = useState<HealthWeeklyReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [granularity, setGranularity] = useState<Granularity>('week');
  const [periodIndex, setPeriodIndex] = useState<number>(-1); // -1 = "not yet set, use latest"
  const [selectedMetric, setSelectedMetric] = useState<MetricKey>('steps');

  useEffect(() => {
    api
      .listHealthWeekly()
      .then(setWeeks)
      .catch((e) => setError(String(e)));
  }, []);

  const periods = useMemo(() => (weeks ? buildPeriods(weeks, granularity) : []), [weeks, granularity]);

  // Switching granularity (or loading data for the first time) lands on the
  // most recent period — periodIndex only tracks an explicit Prev/Next move
  // away from that.
  const activeIndex = periodIndex >= 0 && periodIndex < periods.length ? periodIndex : periods.length - 1;
  const current = periods[activeIndex] ?? null;

  function changeGranularity(g: Granularity) {
    setGranularity(g);
    setPeriodIndex(-1);
  }

  if (error) return <div className="empty-state">Couldn't load health data: {error}</div>;
  if (!weeks) return <div className="empty-state">Loading…</div>;
  if (weeks.length === 0) {
    return <div className="empty-state">No health data yet — upload a Google Health weekly report from Settings → Upload to get started.</div>;
  }

  const metric = METRICS[selectedMetric];
  const labels = current ? periodLabels(current, granularity) : null;

  return (
    <div>
      <div className="dashboard-page__controls">
        <div className="dashboard-page__granularity-tabs">
          {GRANULARITIES.map((g) => (
            <button key={g.id} type="button" className={`dashboard-page__tab${granularity === g.id ? ' is-active' : ''}`} onClick={() => changeGranularity(g.id)}>
              {g.label}
            </button>
          ))}
        </div>
        <div className="dashboard-page__period-nav">
          <div className="dashboard-page__period-pill">
            <button type="button" className="dashboard-page__nav-btn" disabled={activeIndex <= 0} onClick={() => setPeriodIndex(activeIndex - 1)} aria-label="Previous period">
              ‹
            </button>
            <span className="dashboard-page__period-label">
              <span className="dashboard-page__period-main">{labels?.main}</span>
              {labels?.sub && <span className="dashboard-page__period-sublabel">{labels.sub}</span>}
            </span>
            <button
              type="button"
              className="dashboard-page__nav-btn"
              disabled={activeIndex >= periods.length - 1}
              onClick={() => setPeriodIndex(activeIndex + 1)}
              aria-label="Next period"
            >
              ›
            </button>
          </div>
          {activeIndex < periods.length - 1 && (
            <button type="button" className="chip" onClick={() => setPeriodIndex(-1)}>
              Jump to latest
            </button>
          )}
        </div>
      </div>

      {current && (
        <>
          <p className="dashboard-page__tiles-hint">
            Deltas compare to the most recent earlier period with data (hover a delta to see which one). Sparklines
            show that same tile's own trend over the last 8 periods.
          </p>
          <div className="dashboard-page__tiles">
            <Tile
              label="Steps"
              value={current.totalSteps != null ? current.totalSteps.toLocaleString() : null}
              delta={(() => {
                const d = periodDeltaWithRef(periods, activeIndex, 'totalSteps');
                return <DeltaBadge value={d?.value ?? null} refLabel={d?.refLabel} />;
              })()}
              sparkline={<Sparkline values={periods.slice(Math.max(0, activeIndex - 7), activeIndex + 1).map((p) => p.totalSteps)} />}
              active={selectedMetric === 'steps'}
              onClick={() => setSelectedMetric('steps')}
            />
            <Tile
              label="Miles"
              value={current.totalMiles != null ? current.totalMiles.toFixed(2) : null}
              delta={(() => {
                const d = periodDeltaWithRef(periods, activeIndex, 'totalMiles');
                return <DeltaBadge value={d?.value ?? null} unit=" mi" refLabel={d?.refLabel} />;
              })()}
              sparkline={<Sparkline values={periods.slice(Math.max(0, activeIndex - 7), activeIndex + 1).map((p) => p.totalMiles)} />}
              active={selectedMetric === 'miles'}
              onClick={() => setSelectedMetric('miles')}
            />
            <Tile
              label="Calories Burned"
              value={current.avgCaloriesBurned != null ? Math.round(current.avgCaloriesBurned).toLocaleString() : null}
              sparkline={<Sparkline values={periods.slice(Math.max(0, activeIndex - 7), activeIndex + 1).map((p) => p.avgCaloriesBurned)} />}
              active={selectedMetric === 'calories'}
              onClick={() => setSelectedMetric('calories')}
            />
            <Tile
              label="Active Zone Minutes"
              value={current.avgActiveZoneMinutes != null ? String(Math.round(current.avgActiveZoneMinutes)) : null}
              delta={(() => {
                const d = periodDeltaWithRef(periods, activeIndex, 'avgActiveZoneMinutes');
                return <DeltaBadge value={d?.value ?? null} unit=" min" refLabel={d?.refLabel} />;
              })()}
              sparkline={<Sparkline values={periods.slice(Math.max(0, activeIndex - 7), activeIndex + 1).map((p) => p.avgActiveZoneMinutes)} />}
              active={selectedMetric === 'azm'}
              onClick={() => setSelectedMetric('azm')}
            />
            <Tile
              label="Restful Sleep (avg/night)"
              value={current.avgRestfulSleepMinutes != null ? `${Math.floor(current.avgRestfulSleepMinutes / 60)}h ${Math.round(current.avgRestfulSleepMinutes % 60)}m` : null}
              sparkline={<Sparkline values={periods.slice(Math.max(0, activeIndex - 7), activeIndex + 1).map((p) => p.avgRestfulSleepMinutes)} />}
              active={selectedMetric === 'sleep'}
              onClick={() => setSelectedMetric('sleep')}
            />
            <Tile
              label="Resting Heart Rate"
              value={current.avgRestingHeartRate != null ? `${Math.round(current.avgRestingHeartRate)} bpm` : null}
              delta={(() => {
                const d = periodDeltaWithRef(periods, activeIndex, 'avgRestingHeartRate');
                return <DeltaBadge value={d?.value ?? null} unit=" bpm" invert refLabel={d?.refLabel} />;
              })()}
              sparkline={<Sparkline values={periods.slice(Math.max(0, activeIndex - 7), activeIndex + 1).map((p) => p.avgRestingHeartRate)} />}
              active={selectedMetric === 'heartRate'}
              onClick={() => setSelectedMetric('heartRate')}
            />
            <Tile
              label="Weight"
              value={current.avgWeightLb != null ? `${current.avgWeightLb.toFixed(1)} lb` : null}
              delta={(() => {
                const d = periodDeltaWithRef(periods, activeIndex, 'avgWeightLb');
                return <DeltaBadge value={d?.value ?? null} unit=" lb" invert refLabel={d?.refLabel} />;
              })()}
              sparkline={<Sparkline values={periods.slice(Math.max(0, activeIndex - 7), activeIndex + 1).map((p) => p.avgWeightLb)} />}
              active={selectedMetric === 'weight'}
              onClick={() => setSelectedMetric('weight')}
            />
            <Tile
              label="Best Day"
              value={current.bestDaySteps != null ? `${current.bestDaySteps.toLocaleString()}${current.bestDayWeekday ? ` (${current.bestDayWeekday})` : ''}` : null}
              delta={(() => {
                const d = periodDeltaWithRef(periods, activeIndex, 'bestDaySteps');
                return <DeltaBadge value={d?.value ?? null} refLabel={d?.refLabel} />;
              })()}
              sparkline={<Sparkline values={periods.slice(Math.max(0, activeIndex - 7), activeIndex + 1).map((p) => p.bestDaySteps)} />}
            />
          </div>
        </>
      )}

      <div className="dashboard-page__trend-panel card">
        <div className="dashboard-page__trend-header">
          <div className="dashboard-page__metric-tabs">
            {(Object.keys(METRICS) as MetricKey[]).map((k) => (
              <button key={k} type="button" className={`dashboard-page__tab dashboard-page__tab--small${selectedMetric === k ? ' is-active' : ''}`} onClick={() => setSelectedMetric(k)}>
                {METRICS[k].label}
              </button>
            ))}
          </div>
        </div>
        <TrendChart config={metric} periods={periods} currentIndex={activeIndex} />
      </div>

      <p className="dashboard-page__footnote">
        Bars with no value (or "No data") are periods the tracker wasn't worn — heart rate, sleep, and active zone
        minutes can't be a real zero for a whole week, so those come through blank rather than as misleading zeros.
        Weight can stay flat for several weeks in a row if there wasn't a new scale reading — Google Health appears
        to carry the last known weight forward rather than leaving it blank, so month/quarter/year views show the
        most recent reading in the period rather than averaging in the duplicates.
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
        <select className="dashboard-page__area-select" value={area} onChange={(e) => setArea(e.target.value as LifeArea)}>
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

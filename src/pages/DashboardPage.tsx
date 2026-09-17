import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { HealthWeeklyReport } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';
import { buildPeriods, periodDelta, type AggregatedPeriod, type Granularity } from '../utils/healthPeriods';

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
  chartUnit: string; // shown after the number on the trend chart / tooltip
  deltaUnit: string; // shown after the number in a delta badge
  decimals: number;
  invert?: boolean; // true when a decrease is the "good" direction (heart rate, weight)
  get: (p: AggregatedPeriod) => number | null;
  formatTile: (v: number) => string;
}

const METRICS: Record<MetricKey, MetricConfig> = {
  steps: {
    label: 'Steps',
    chartUnit: '',
    deltaUnit: '',
    decimals: 0,
    get: (p) => p.totalSteps,
    formatTile: (v) => v.toLocaleString(),
  },
  miles: {
    label: 'Miles',
    chartUnit: ' mi',
    deltaUnit: ' mi',
    decimals: 2,
    get: (p) => p.totalMiles,
    formatTile: (v) => v.toFixed(2),
  },
  calories: {
    label: 'Calories Burned (avg/day)',
    chartUnit: '',
    deltaUnit: '',
    decimals: 0,
    get: (p) => p.avgCaloriesBurned,
    formatTile: (v) => Math.round(v).toLocaleString(),
  },
  azm: {
    label: 'Active Zone Minutes',
    chartUnit: ' min',
    deltaUnit: ' min',
    decimals: 0,
    get: (p) => p.avgActiveZoneMinutes,
    formatTile: (v) => String(Math.round(v)),
  },
  sleep: {
    label: 'Restful Sleep',
    chartUnit: 'h',
    deltaUnit: ' min',
    decimals: 1,
    get: (p) => p.avgRestfulSleepMinutes,
    formatTile: (v) => `${Math.floor(v / 60)}h ${Math.round(v % 60)}m`,
  },
  heartRate: {
    label: 'Resting Heart Rate',
    chartUnit: ' bpm',
    deltaUnit: ' bpm',
    decimals: 0,
    invert: true,
    get: (p) => p.avgRestingHeartRate,
    formatTile: (v) => `${Math.round(v)} bpm`,
  },
  weight: {
    label: 'Weight',
    chartUnit: ' lb',
    deltaUnit: ' lb',
    decimals: 1,
    invert: true,
    get: (p) => p.avgWeightLb,
    formatTile: (v) => `${v.toFixed(1)} lb`,
  },
};

function DeltaBadge({ value, unit = '', invert = false }: { value: number | null; unit?: string; invert?: boolean }) {
  if (value === null || Math.abs(value) < 0.05) return null;
  const good = invert ? value < 0 : value > 0;
  const sign = value > 0 ? '+' : '';
  return (
    <span className={`dashboard-page__tile-delta${good ? ' is-up' : ' is-down'}`}>
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
  const values = periods.map((p) => config.get(p));
  const present = values.filter((v): v is number => v != null);
  if (present.length === 0) {
    return <div className="empty-state">No data yet for {config.label.toLowerCase()}.</div>;
  }
  const min = Math.min(...present);
  const max = Math.max(...present);
  const range = max - min || 1;
  const avg = present.reduce((a, b) => a + b, 0) / present.length;
  const selectedValue = values[currentIndex];

  return (
    <div>
      <div className="dashboard-page__trend-range">
        {periods[0].shortLabel} – {periods[periods.length - 1].shortLabel}
        {periods.length > 1 ? ` · ${periods.length} periods` : ''}
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
          <span className="dashboard-page__trend-stat-value">{config.formatTile(min)}</span>
        </div>
        <div>
          <span className="dashboard-page__trend-stat-label">High</span>
          <span className="dashboard-page__trend-stat-value">{config.formatTile(max)}</span>
        </div>
      </div>
      <div className={`dashboard-page__chart-bars dashboard-page__chart-bars--large${periods.length > 16 ? ' is-dense' : ''}`}>
        {periods.map((p, i) => {
          const v = values[i];
          const pct = v == null ? 0 : 10 + ((v - min) / range) * 90;
          return (
            <div
              key={p.key}
              className={`dashboard-page__chart-col${i === currentIndex ? ' is-current' : ''}`}
              title={v == null ? `${p.shortLabel}: no data` : `${p.label}: ${v.toFixed(config.decimals)}${config.chartUnit}`}
            >
              <div className="dashboard-page__chart-count">{v == null ? '' : v.toFixed(config.decimals)}</div>
              <div className={`dashboard-page__chart-bar${v == null ? ' is-empty' : ''}`} style={{ height: `${v == null ? 3 : pct}%` }} />
              <div className="dashboard-page__chart-date">{p.shortLabel}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Zoom presets — how many periods (bars) the trend chart reaches back from
// the pill's own period, which is always the first option and therefore
// the default: the chart lands showing exactly the one period the pill is
// on, and widens from there only when asked. Weeks are framed in actual
// calendar days per Mike's own ask (a week already *is* 7 days, so "Last 7
// Days" is just that one week; "Last 14/30 Days" round to the nearest
// whole week); month/quarter/year use the equivalent "this period, then a
// few more, then all of it" shape since a literal day count stops being a
// natural unit once a bar is a month or more wide.
const ZOOM_OPTIONS_BY_GRANULARITY: Record<Granularity, { id: number; label: string }[]> = {
  week: [
    { id: 1, label: 'Last 7 Days' },
    { id: 2, label: 'Last 14 Days' },
    { id: 4, label: 'Last 30 Days' },
    { id: 0, label: 'All' },
  ],
  month: [
    { id: 1, label: 'This Month' },
    { id: 3, label: 'Last 3 Months' },
    { id: 6, label: 'Last 6 Months' },
    { id: 0, label: 'All' },
  ],
  quarter: [
    { id: 1, label: 'This Quarter' },
    { id: 4, label: 'Last 4 Quarters' },
    { id: 0, label: 'All' },
  ],
  year: [
    { id: 1, label: 'This Year' },
    { id: 0, label: 'All' },
  ],
};

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
  const [zoom, setZoom] = useState<number>(1); // 1 = exactly the pill's own period, matching ZOOM_OPTIONS_BY_GRANULARITY's first entry

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
    setZoom(ZOOM_OPTIONS_BY_GRANULARITY[g][0].id);
  }

  // The trend chart always mirrors the period pill above it — it ends at
  // whichever period Prev/Next has selected (never later, even for "All"),
  // and the zoom picker only controls how far back from there it reaches.
  // A short zoom near the start of the data legitimately shows fewer bars
  // than the preset asks for (e.g. "Last 30" on the 4th week ever tracked
  // can only show 4) — that's correct, not a bug, and the date range below
  // the picker always states exactly what's on screen.
  const zoomedPeriods = useMemo(() => {
    const end = Math.min(periods.length, activeIndex + 1);
    const start = zoom === 0 ? 0 : Math.max(0, end - zoom);
    return periods.slice(start, end);
  }, [periods, zoom, activeIndex]);

  const zoomedActiveIndexInWindow = zoomedPeriods.length - 1; // the pill's period is always the last bar shown

  if (error) return <div className="empty-state">Couldn't load health data: {error}</div>;
  if (!weeks) return <div className="empty-state">Loading…</div>;
  if (weeks.length === 0) {
    return <div className="empty-state">No health data yet — upload a Google Health weekly report from Settings → Upload to get started.</div>;
  }

  const metric = METRICS[selectedMetric];
  const labels = current ? periodLabels(current, granularity) : null;
  const zoomOptions = ZOOM_OPTIONS_BY_GRANULARITY[granularity];

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
        <div className="dashboard-page__tiles">
          <Tile
            label="Steps"
            value={current.totalSteps != null ? current.totalSteps.toLocaleString() : null}
            delta={<DeltaBadge value={periodDelta(periods, activeIndex, 'totalSteps')} />}
            sparkline={
              <Sparkline
                values={periods.slice(Math.max(0, activeIndex - 7), activeIndex + 1).map((p) => p.totalSteps)}
              />
            }
            active={selectedMetric === 'steps'}
            onClick={() => setSelectedMetric('steps')}
          />
          <Tile
            label="Miles"
            value={current.totalMiles != null ? current.totalMiles.toFixed(2) : null}
            delta={<DeltaBadge value={periodDelta(periods, activeIndex, 'totalMiles')} unit=" mi" />}
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
            delta={<DeltaBadge value={periodDelta(periods, activeIndex, 'avgActiveZoneMinutes')} unit=" min" />}
            sparkline={<Sparkline values={periods.slice(Math.max(0, activeIndex - 7), activeIndex + 1).map((p) => p.avgActiveZoneMinutes)} />}
            active={selectedMetric === 'azm'}
            onClick={() => setSelectedMetric('azm')}
          />
          <Tile
            label="Restful Sleep"
            value={current.avgRestfulSleepMinutes != null ? `${Math.floor(current.avgRestfulSleepMinutes / 60)}h ${Math.round(current.avgRestfulSleepMinutes % 60)}m` : null}
            sparkline={<Sparkline values={periods.slice(Math.max(0, activeIndex - 7), activeIndex + 1).map((p) => p.avgRestfulSleepMinutes)} />}
            active={selectedMetric === 'sleep'}
            onClick={() => setSelectedMetric('sleep')}
          />
          <Tile
            label="Resting Heart Rate"
            value={current.avgRestingHeartRate != null ? `${Math.round(current.avgRestingHeartRate)} bpm` : null}
            delta={<DeltaBadge value={periodDelta(periods, activeIndex, 'avgRestingHeartRate')} unit=" bpm" invert />}
            sparkline={<Sparkline values={periods.slice(Math.max(0, activeIndex - 7), activeIndex + 1).map((p) => p.avgRestingHeartRate)} />}
            active={selectedMetric === 'heartRate'}
            onClick={() => setSelectedMetric('heartRate')}
          />
          <Tile
            label="Weight"
            value={current.avgWeightLb != null ? `${current.avgWeightLb.toFixed(1)} lb` : null}
            delta={<DeltaBadge value={periodDelta(periods, activeIndex, 'avgWeightLb')} unit=" lb" invert />}
            sparkline={<Sparkline values={periods.slice(Math.max(0, activeIndex - 7), activeIndex + 1).map((p) => p.avgWeightLb)} />}
            active={selectedMetric === 'weight'}
            onClick={() => setSelectedMetric('weight')}
          />
          <Tile
            label="Best Day"
            value={current.bestDaySteps != null ? `${current.bestDaySteps.toLocaleString()}${current.bestDayWeekday ? ` (${current.bestDayWeekday})` : ''}` : null}
            delta={<DeltaBadge value={periodDelta(periods, activeIndex, 'bestDaySteps')} />}
            sparkline={<Sparkline values={periods.slice(Math.max(0, activeIndex - 7), activeIndex + 1).map((p) => p.bestDaySteps)} />}
          />
        </div>
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
          <div className="dashboard-page__zoom-tabs">
            {zoomOptions.map((z) => (
              <button key={z.id} type="button" className={`chip${zoom === z.id ? ' is-active' : ''}`} onClick={() => setZoom(z.id)}>
                {z.label}
              </button>
            ))}
          </div>
        </div>
        <TrendChart config={metric} periods={zoomedPeriods} currentIndex={zoomedActiveIndexInWindow} />
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

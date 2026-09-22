import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type { Bet, BetResult, HealthWeeklyReport } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';
import { buildPeriods, periodDeltaWithRef, type AggregatedPeriod, type Granularity } from '../utils/healthPeriods';
import {
  BET_TYPES,
  COMMON_SPORTSBOOKS,
  RESULT_OPTIONS,
  SPORTS,
  buildBetPeriods,
  computeProfit,
  formatMoney,
  formatOdds,
  resultLabel,
  type AggregatedBetPeriod,
  type BetGroupStat,
} from '../utils/bets';
import { Modal } from '../components/Modal';
import { ConfirmModal } from '../components/ConfirmModal';
import { KebabMenu } from '../components/KebabMenu';

type LifeArea = 'fitness' | 'betting' | 'finance' | 'vehicle';

const LIFE_AREAS: { id: LifeArea; label: string; icon: string; available: boolean }[] = [
  { id: 'fitness', label: 'Fitness', icon: '🩺', available: true },
  { id: 'betting', label: 'Betting', icon: '🎲', available: true },
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

// ---- Betting dashboard ----

function ResultBadge({ result }: { result: BetResult }) {
  return <span className={`bets__result-badge bets__result-badge--${result}`}>{resultLabel(result)}</span>;
}

/** Zero-anchored bidirectional bar chart for net profit per period — unlike
 * the Fitness TrendChart (which scales every metric to its own non-negative
 * min/max), a bet period's net can be a loss, so this needs a real zero
 * baseline with bars growing up (green, profit) or down (red, loss) from
 * it, not a min/max-scaled band. Same hand-rolled-bars approach as the rest
 * of this page (no charting dependency), just a different anchor. */
function NetProfitChart({ periods, currentIndex }: { periods: AggregatedBetPeriod[]; currentIndex: number }) {
  const currentColRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    currentColRef.current?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [currentIndex, periods]);

  if (periods.length === 0) return null;
  const maxAbs = Math.max(1, ...periods.map((p) => Math.abs(p.net)));

  return (
    <div className="dashboard-page__chart-scroll">
      <div className={`bets-chart${periods.length > 16 ? ' is-dense' : ''}`}>
        {periods.map((p, i) => {
          const pct = Math.min(100, (Math.abs(p.net) / maxAbs) * 100);
          return (
            <div
              key={p.key}
              ref={i === currentIndex ? currentColRef : undefined}
              className={`bets-chart__col${i === currentIndex ? ' is-current' : ''}`}
              title={`${p.label}: ${formatMoney(p.net)}`}
            >
              <div className="bets-chart__amount">{p.net !== 0 ? formatMoney(p.net) : ''}</div>
              <div className="bets-chart__top">{p.net > 0 && <div className="bets-chart__bar bets-chart__bar--pos" style={{ height: `${pct}%` }} />}</div>
              <div className="bets-chart__zero" />
              <div className="bets-chart__bottom">{p.net < 0 && <div className="bets-chart__bar bets-chart__bar--neg" style={{ height: `${pct}%` }} />}</div>
              <div className="bets-chart__label">{p.shortLabel}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** "Performance by sport / bet type / sportsbook" — sorted best-net-first so
 * what's working (and what isn't) is visible without hunting for it. */
function BreakdownTable({ title, rows }: { title: string; rows: BetGroupStat[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="bets-breakdown card">
      <div className="bets-breakdown__title">{title}</div>
      <div className="bets-breakdown__row bets-breakdown__row--head">
        <span>Name</span>
        <span>Bets</span>
        <span>Risked</span>
        <span>Net</span>
        <span>Win rate</span>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="bets-breakdown__row">
          <span className="bets-breakdown__name">{r.key}</span>
          <span>{r.count}</span>
          <span>{formatMoney(r.risked)}</span>
          <span className={`bets-breakdown__net ${r.net >= 0 ? 'is-up' : 'is-down'}`}>{formatMoney(r.net)}</span>
          <span>{r.winRate != null ? `${Math.round(r.winRate * 100)}%` : '—'}</span>
        </div>
      ))}
    </div>
  );
}

function todayLocalISODash(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Add/edit form for a single bet. Odds + wager + result drive an
 * auto-calculated profit (see computeProfit); the "override" field is
 * collapsed by default and only meant for the rare bet where the actual
 * payout doesn't match plain odds math (a boost, a free bet, a partial
 * void). */
function BetFormModal({ bet, onClose, onSave }: { bet: Bet | null; onClose: () => void; onSave: (params: Record<string, unknown>) => Promise<void> }) {
  const [date, setDate] = useState(bet?.date ?? todayLocalISODash());
  const [sport, setSport] = useState(bet?.sport ?? SPORTS[0]);
  const [sportsbook, setSportsbook] = useState(bet?.sportsbook ?? '');
  const [betType, setBetType] = useState(bet?.bet_type ?? BET_TYPES[0]);
  const [pick, setPick] = useState(bet?.pick ?? '');
  const [odds, setOdds] = useState(bet ? String(bet.odds) : '');
  const [wager, setWager] = useState(bet ? String(bet.wager) : '');
  const [result, setResult] = useState<BetResult>(bet?.result ?? 'win');
  const [notes, setNotes] = useState(bet?.notes ?? '');
  const [showOverride, setShowOverride] = useState(bet?.manual_profit != null);
  const [manualProfit, setManualProfit] = useState(bet?.manual_profit != null ? String(bet.manual_profit) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const oddsNum = Number(odds);
  const wagerNum = Number(wager);
  const previewProfit =
    Number.isFinite(oddsNum) && oddsNum !== 0 && Number.isFinite(wagerNum) && wagerNum > 0
      ? computeProfit({ odds: oddsNum, wager: wagerNum, result, manual_profit: showOverride && manualProfit !== '' ? Number(manualProfit) : null } as Bet)
      : null;

  async function handleSave() {
    if (!sportsbook.trim()) return setError('Sportsbook is required.');
    if (!Number.isFinite(oddsNum) || oddsNum === 0) return setError('Odds must be a non-zero number, e.g. -110 or 150.');
    if (!Number.isFinite(wagerNum) || wagerNum <= 0) return setError('Wager must be a positive number.');
    setSaving(true);
    setError(null);
    try {
      await onSave({
        date,
        sport,
        sportsbook: sportsbook.trim(),
        bet_type: betType,
        pick: pick.trim() || undefined,
        odds: oddsNum,
        wager: wagerNum,
        result,
        manual_profit: showOverride && manualProfit !== '' ? Number(manualProfit) : null,
        notes: notes.trim() || undefined,
      });
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  return (
    <Modal title={bet ? 'Edit Bet' : 'Log a Bet'} onClose={onClose}>
      <div className="bets-form">
        <label className="bets-form__field">
          <span>Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="bets-form__field">
          <span>Sport</span>
          <select value={sport} onChange={(e) => setSport(e.target.value)}>
            {SPORTS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="bets-form__field">
          <span>Sportsbook</span>
          <input list="bets-sportsbooks" placeholder="DraftKings" value={sportsbook} onChange={(e) => setSportsbook(e.target.value)} />
          <datalist id="bets-sportsbooks">
            {COMMON_SPORTSBOOKS.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </label>
        <label className="bets-form__field">
          <span>Bet type</span>
          <select value={betType} onChange={(e) => setBetType(e.target.value)}>
            {BET_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="bets-form__field">
          <span>Pick</span>
          <input placeholder="Chiefs -3.5" value={pick} onChange={(e) => setPick(e.target.value)} />
        </label>
        <div className="bets-form__row">
          <label className="bets-form__field">
            <span>Odds (American)</span>
            <input placeholder="-110" value={odds} onChange={(e) => setOdds(e.target.value)} />
          </label>
          <label className="bets-form__field">
            <span>Wager</span>
            <input placeholder="25" inputMode="decimal" value={wager} onChange={(e) => setWager(e.target.value)} />
          </label>
        </div>
        <label className="bets-form__field">
          <span>Result</span>
          <select value={result} onChange={(e) => setResult(e.target.value as BetResult)}>
            {RESULT_OPTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>

        {previewProfit != null && (
          <div className={`bets-form__preview ${previewProfit >= 0 ? 'is-up' : 'is-down'}`}>
            {previewProfit >= 0 ? 'Profit' : 'Loss'}: {formatMoney(previewProfit)}
          </div>
        )}

        {!showOverride ? (
          <button type="button" className="link-btn" onClick={() => setShowOverride(true)}>
            Override calculated profit (boost, free bet, partial void…)
          </button>
        ) : (
          <label className="bets-form__field">
            <span>Actual profit/loss (overrides the calculation above)</span>
            <input placeholder="e.g. 37.50 or -25" inputMode="decimal" value={manualProfit} onChange={(e) => setManualProfit(e.target.value)} />
          </label>
        )}

        <label className="bets-form__field">
          <span>Notes (optional)</span>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        {error && <div className="bets-form__error">{error}</div>}
      </div>
      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button className="btn" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : bet ? 'Save' : 'Log Bet'}
        </button>
      </div>
    </Modal>
  );
}

function BettingDashboard() {
  const [bets, setBets] = useState<Bet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [granularity, setGranularity] = useState<Granularity>('month');
  const [periodIndex, setPeriodIndex] = useState<number>(-1);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Bet | null>(null);
  const [deleting, setDeleting] = useState<Bet | null>(null);

  const load = () => api.listBets().then(setBets).catch((e) => setError(String(e)));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const periods = useMemo(() => (bets ? buildBetPeriods(bets, granularity) : []), [bets, granularity]);
  const activeIndex = periodIndex >= 0 && periodIndex < periods.length ? periodIndex : periods.length - 1;
  const current = periods[activeIndex] ?? null;

  function changeGranularity(g: Granularity) {
    setGranularity(g);
    setPeriodIndex(-1);
  }

  async function handleCreate(params: Record<string, unknown>) {
    await api.createBet(params as Parameters<typeof api.createBet>[0]);
    setAdding(false);
    load();
  }

  async function handleUpdate(params: Record<string, unknown>) {
    if (!editing) return;
    await api.updateBet(editing.id, params);
    setEditing(null);
    load();
  }

  async function handleDelete(bet: Bet) {
    setBets((prev) => (prev ? prev.filter((b) => b.id !== bet.id) : prev));
    await api.deleteBet(bet.id);
    setDeleting(null);
  }

  if (error) return <div className="empty-state">Couldn't load bets: {error}</div>;
  if (!bets) return <div className="empty-state">Loading…</div>;

  if (bets.length === 0) {
    return (
      <div>
        <div className="toolbar-row">
          <button className="btn" onClick={() => setAdding(true)}>
            + Log a Bet
          </button>
        </div>
        <div className="empty-state">No bets logged yet — log one the day after you make it: sport, sportsbook, odds, wager, and the result.</div>
        {adding && <BetFormModal bet={null} onClose={() => setAdding(false)} onSave={handleCreate} />}
      </div>
    );
  }

  const labels = current ? { main: current.label, sub: `${current.bets.length} bet${current.bets.length === 1 ? '' : 's'}` } : null;

  return (
    <div>
      <div className="toolbar-row">
        <div />
        <button className="btn" onClick={() => setAdding(true)}>
          + Log a Bet
        </button>
      </div>

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
          <div className="dashboard-page__tiles">
            <Tile label="Risked" value={formatMoney(current.risked)} />
            <Tile label="Won" value={formatMoney(current.won)} />
            <Tile label="Lost" value={formatMoney(current.lost)} />
            <Tile label="Net" value={formatMoney(current.net)} delta={<span className={`bets-net-tag ${current.net >= 0 ? 'is-up' : 'is-down'}`}>{current.net >= 0 ? 'Profit' : 'Loss'}</span>} />
            <Tile label="ROI" value={current.roi != null ? `${(current.roi * 100).toFixed(1)}%` : null} />
            <Tile label="Win Rate" value={current.winRate != null ? `${Math.round(current.winRate * 100)}%` : null} aside={`${current.wins}-${current.losses}${current.pushes ? `-${current.pushes}p` : ''}`} />
            <Tile
              label="Biggest Win"
              value={current.biggestWin ? formatMoney(current.biggestWin.profit) : null}
              aside={current.biggestWin ? `${current.biggestWin.bet.pick || current.biggestWin.bet.sport} · ${current.biggestWin.bet.sportsbook}` : null}
            />
            <Tile
              label="Biggest Loss"
              value={current.biggestLoss ? formatMoney(current.biggestLoss.profit) : null}
              aside={current.biggestLoss ? `${current.biggestLoss.bet.pick || current.biggestLoss.bet.sport} · ${current.biggestLoss.bet.sportsbook}` : null}
            />
          </div>
        </>
      )}

      <div className="dashboard-page__trend-panel card">
        <div className="dashboard-page__trend-header">
          <span className="dashboard-page__trend-range">Net profit by {granularity}</span>
        </div>
        <NetProfitChart periods={periods} currentIndex={activeIndex} />
      </div>

      {current && (
        <div className="bets-breakdowns">
          <BreakdownTable title="By sport" rows={current.bySport} />
          <BreakdownTable title="By bet type" rows={current.byBetType} />
          <BreakdownTable title="By sportsbook" rows={current.bySportsbook} />
        </div>
      )}

      {current && current.bets.length > 0 && (
        <div className="bets-log card">
          <div className="bets-breakdown__title">Bets this period</div>
          {[...current.bets].reverse().map((bet) => {
            const profit = computeProfit(bet);
            return (
              <div key={bet.id} className="bets-log__row">
                <div className="bets-log__main">
                  <span className="bets-log__date">{bet.date}</span>
                  <span className="bets-log__pick">{bet.pick || `${bet.sport} ${bet.bet_type}`}</span>
                  <span className="bets-log__meta">
                    {bet.sport} · {bet.sportsbook} · {formatOdds(bet.odds)} · {formatMoney(bet.wager)}
                  </span>
                </div>
                <ResultBadge result={bet.result} />
                <span className={`bets-log__profit ${profit >= 0 ? 'is-up' : 'is-down'}`}>{formatMoney(profit)}</span>
                <KebabMenu
                  items={[
                    { label: 'Edit', onClick: () => setEditing(bet) },
                    { label: 'Delete', onClick: () => setDeleting(bet), danger: true, separatorBefore: true },
                  ]}
                />
              </div>
            );
          })}
        </div>
      )}

      {adding && <BetFormModal bet={null} onClose={() => setAdding(false)} onSave={handleCreate} />}
      {editing && <BetFormModal bet={editing} onClose={() => setEditing(null)} onSave={handleUpdate} />}
      {deleting && (
        <ConfirmModal
          title="Delete bet?"
          body={`This ${deleting.date} ${deleting.sport} bet will be permanently deleted.`}
          onConfirm={() => handleDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
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
      {area === 'betting' && <BettingDashboard />}
      {area !== 'fitness' && area !== 'betting' && (
        <div className="empty-state">
          {LIFE_AREAS.find((a) => a.id === area)?.label} isn't built yet — Fitness and Betting are the life areas
          wired up so far; this dropdown is where the rest (Finance, Vehicle, and anything else) will live as
          they're added.
        </div>
      )}
    </div>
  );
}

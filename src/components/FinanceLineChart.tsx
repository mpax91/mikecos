import { useLayoutEffect, useRef, useState } from 'react';

export interface LineSeries {
  name: string;
  color: string;
  points: { x: number; y: number }[]; // x = epoch ms
  step?: boolean; // draw as a step line (e.g. cumulative deposits)
}

interface Props {
  series: LineSeries[];
  height?: number;
  formatY: (v: number) => string;
  formatX: (ms: number) => string;
  ariaLabel: string;
  yFromZero?: boolean;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (max <= min) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

/** Small dependency-free SVG line chart: one y-axis, recessive grid, 2px
 * lines, legend for 2+ series plus end-of-line direct labels, and a
 * crosshair tooltip on hover/touch. */
export function FinanceLineChart({ series, height = 220, formatY, formatX, ariaLabel, yFromZero = true }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hoverX, setHoverX] = useState<number | null>(null);
  const all = series.flatMap((s) => s.points);
  if (!all.length) return <div className="finance-chart__empty">No data yet.</div>;

  const pad = { l: 64, r: 16, t: 12, b: 28 };
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs) === xMin ? xMin + 86400000 : Math.max(...xs);
  const yLo = yFromZero ? Math.min(0, ...ys) : Math.min(...ys);
  const yHi = Math.max(...ys);
  const span = yHi - yLo || Math.abs(yHi) || 1;
  const yMin = yFromZero ? yLo : yLo - span * 0.08;
  const yMax = yHi + span * 0.08;
  const sx = (x: number) => pad.l + ((x - xMin) / (xMax - xMin)) * (width - pad.l - pad.r);
  const sy = (y: number) => pad.t + (1 - (y - yMin) / (yMax - yMin)) * (height - pad.t - pad.b);

  const path = (s: LineSeries) =>
    s.points
      .map((p, i) => {
        if (i === 0) return `M${sx(p.x)},${sy(p.y)}`;
        return s.step ? `H${sx(p.x)}V${sy(p.y)}` : `L${sx(p.x)},${sy(p.y)}`;
      })
      .join('');

  const yTicks = niceTicks(yMin, yMax);
  const xTickCount = Math.min(5, Math.max(2, Math.floor(width / 140)));
  const xTicks = Array.from({ length: xTickCount }, (_, i) => xMin + ((xMax - xMin) * i) / (xTickCount - 1));

  // Hover: snap to the nearest x that any series has a point at.
  const uniqX = [...new Set(xs)].sort((a, b) => a - b);
  const valueAt = (s: LineSeries, x: number): number | null => {
    let v: number | null = null;
    for (const p of s.points) {
      if (p.x <= x) v = p.y;
      else break;
    }
    return v;
  };
  function onMove(clientX: number) {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const px = clientX - rect.left;
    let best = uniqX[0];
    for (const x of uniqX) if (Math.abs(sx(x) - px) < Math.abs(sx(best) - px)) best = x;
    setHoverX(best);
  }

  const tipLeft = hoverX !== null ? Math.min(Math.max(sx(hoverX) + 10, 0), width - 170) : 0;

  return (
    <div className="finance-chart">
      {series.length > 1 && (
        <div className="finance-chart__legend">
          {series.map((s) => (
            <span key={s.name} className="finance-chart__legend-item">
              <span className="finance-chart__swatch" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <div
        ref={ref}
        className="finance-chart__plot"
        onMouseMove={(e) => onMove(e.clientX)}
        onMouseLeave={() => setHoverX(null)}
        onTouchStart={(e) => onMove(e.touches[0].clientX)}
        onTouchMove={(e) => onMove(e.touches[0].clientX)}
      >
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={width - pad.r} y1={sy(t)} y2={sy(t)} className="finance-chart__grid" />
              <text x={pad.l - 8} y={sy(t)} className="finance-chart__tick" textAnchor="end" dominantBaseline="middle">
                {formatY(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text key={t} x={sx(t)} y={height - 8} className="finance-chart__tick" textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}>
              {formatX(t)}
            </text>
          ))}
          {series.map((s) => (
            <path key={s.name} d={path(s)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {hoverX !== null && (
            <>
              <line x1={sx(hoverX)} x2={sx(hoverX)} y1={pad.t} y2={height - pad.b} className="finance-chart__crosshair" />
              {series.map((s) => {
                const v = valueAt(s, hoverX);
                return v === null ? null : <circle key={s.name} cx={sx(hoverX)} cy={sy(v)} r={4.5} fill={s.color} stroke="var(--color-card-bg)" strokeWidth={2} />;
              })}
            </>
          )}
        </svg>
        {hoverX !== null && (
          <div className="finance-chart__tip" style={{ left: tipLeft }}>
            <div className="finance-chart__tip-date">{formatX(hoverX)}</div>
            {series.map((s) => {
              const v = valueAt(s, hoverX);
              return v === null ? null : (
                <div key={s.name} className="finance-chart__tip-row">
                  <span className="finance-chart__swatch" style={{ background: s.color }} />
                  <span>{s.name}</span>
                  <strong>{formatY(v)}</strong>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

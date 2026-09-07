import { useEffect, useRef, useState } from 'react';
import type { WeatherDay } from '../api/types';

/** A day's forecast, shown as either a compact chip (Week view's column
 * header) or a fuller sentence (Day view, next to the heading) — both
 * open the same small popover on click with the detail that didn't fit
 * inline (precipitation chance, wind). Renders nothing when there's no
 * forecast for this date (past days, or beyond Open-Meteo's ~16-day
 * window) rather than an empty/placeholder chip. */
export function WeatherWidget({ day, variant }: { day: WeatherDay | undefined; variant: 'chip' | 'sentence' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  if (!day) return null;

  return (
    <div ref={ref} className={`weather-widget weather-widget--${variant}`} onClick={(e) => e.stopPropagation()}>
      {variant === 'chip' ? (
        <button type="button" className="weather-chip" onClick={() => setOpen((v) => !v)}>
          <span>{day.icon}</span>
          <span className="weather-chip__temps">
            {day.tempMaxF}° <span className="weather-chip__temp-min">/{day.tempMinF}°</span>
          </span>
        </button>
      ) : (
        <button type="button" className="weather-sentence" onClick={() => setOpen((v) => !v)}>
          {day.icon} {day.summary}, high {day.tempMaxF}° · low {day.tempMinF}° · {day.precipProbability}% chance of rain
        </button>
      )}

      {open && (
        <div className="weather-popover card">
          <div className="weather-popover__headline">
            {day.icon} {day.summary}
          </div>
          <div className="weather-popover__row">
            <span>High / Low</span>
            <span>
              {day.tempMaxF}° / {day.tempMinF}°
            </span>
          </div>
          <div className="weather-popover__row">
            <span>Chance of rain</span>
            <span>{day.precipProbability}%</span>
          </div>
          <div className="weather-popover__row">
            <span>Wind</span>
            <span>{day.windMaxMph} mph</span>
          </div>
        </div>
      )}
    </div>
  );
}

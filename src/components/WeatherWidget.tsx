import type { WeatherDay } from '../api/types';

// Mike's fixed home location for the forecast — matches WEATHER_LOCATION_LABEL
// in the worker (Bedford Hills, NY). Kept here too (rather than threading the
// zip through the API response) since it's only ever used to build this one
// external link.
const FORECAST_ZIP = '10507';

function weekdayName(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long' });
}

/** A day-specific external forecast link — Google's own weather box
 * reliably picks up a "weather <zip> <weekday>" query and jumps straight
 * to that day's forecast, so no API key or provider-specific deep-link
 * format is needed. Rebuilt per day rather than a single fixed URL so
 * clicking Friday's chip actually lands on Friday's forecast, not
 * whatever Google shows by default (today). */
function forecastUrl(day: WeatherDay): string {
  return `https://www.google.com/search?q=${encodeURIComponent(`weather ${FORECAST_ZIP} ${weekdayName(day.date)}`)}`;
}

/** A day's forecast, shown as either a compact chip (Week view's column
 * header) or a fuller sentence (Day view, next to the heading). Both are
 * a plain link out to a day-specific external forecast — the summary/high/
 * low/precip already shown inline covers what a popover would otherwise
 * have repeated, so clicking through is more useful than a second look at
 * the same numbers. Renders nothing when there's no forecast for this date
 * (past days, or beyond Open-Meteo's ~16-day window) rather than an empty/
 * placeholder chip. */
export function WeatherWidget({ day, variant }: { day: WeatherDay | undefined; variant: 'chip' | 'sentence' }) {
  if (!day) return null;

  return (
    <a
      className={`weather-widget weather-widget--${variant}`}
      href={forecastUrl(day)}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`See the full forecast for ${weekdayName(day.date)}`}
    >
      {variant === 'chip' ? (
        <span className="weather-chip">
          <span>{day.icon}</span>
          <span className="weather-chip__temps">
            {day.tempMaxF}° <span className="weather-chip__temp-min">/{day.tempMinF}°</span>
          </span>
        </span>
      ) : (
        <span className="weather-sentence">
          {day.icon} {day.summary}, High {day.tempMaxF}° · Low {day.tempMinF}° · {day.precipProbability}% Chance of Rain
        </span>
      )}
    </a>
  );
}

import type { HabitDirection, HabitSummary } from '../api/types';

/** True when `a` is the more desirable value than `b` for this habit's
 * direction — lower wins for a 'reduce' habit (cutting something down),
 * higher wins for everything else. The one comparison every other
 * function in this file is built on. */
export function isBetter(direction: HabitDirection, a: number, b: number): boolean {
  return direction === 'reduce' ? a < b : a > b;
}

export interface HabitHeadline {
  text: string;
  tone: 'good' | 'neutral' | 'bad';
}

const MIN_HISTORY_FOR_BEST = 3;

/** The one contextual sentence shown under a habit's today count. Prefers,
 * in order: a new personal best (the most motivating thing to surface, and
 * rare enough to be worth interrupting the usual comparison for), today vs.
 * yesterday (the most immediate comparison), then today vs. the 7-day
 * average when yesterday itself was never logged. */
export function habitHeadline(s: HabitSummary): HabitHeadline {
  const { habit, today, yesterday, todayLogged, yesterdayLogged, avg7, best } = s;
  const unit = habit.unit ? ` ${habit.unit}` : '';
  const loggedDays = s.series.filter((d) => d.total > 0).length;

  if (!todayLogged && today === 0) {
    return {
      text: habit.direction === 'reduce' ? "Nothing logged yet today — clean slate." : 'Nothing logged yet today.',
      tone: 'neutral',
    };
  }

  if (best !== null && loggedDays >= MIN_HISTORY_FOR_BEST && today === best && (yesterdayLogged ? today !== yesterday : true)) {
    return {
      text: habit.direction === 'reduce' ? `New low — ${today}${unit} is your best day yet.` : `New personal best — ${today}${unit}.`,
      tone: 'good',
    };
  }

  if (yesterdayLogged) {
    const diff = today - yesterday;
    if (diff === 0) return { text: `Matching yesterday, at ${today}${unit}.`, tone: 'neutral' };
    const better = isBetter(habit.direction, today, yesterday);
    const arrow = diff < 0 ? '↓' : '↑';
    return {
      text: `${arrow} ${Math.abs(diff)}${unit} ${diff < 0 ? 'down' : 'up'} vs. yesterday (${yesterday}${unit}) — ${better ? 'nice work' : 'yesterday was better'}.`,
      tone: better ? 'good' : 'bad',
    };
  }

  if (avg7 > 0) {
    const better = isBetter(habit.direction, today, avg7);
    const word = better ? 'beating' : habit.direction === 'reduce' ? 'above' : 'below';
    return {
      text: `${today}${unit} today, vs. a ${avg7.toFixed(1)}${unit} 7-day average — ${word} your average.`,
      tone: better ? 'good' : today === avg7 ? 'neutral' : 'bad',
    };
  }

  return { text: `${today}${unit} logged today.`, tone: 'neutral' };
}

/** Consecutive most-recent days (walking backward from today) that each
 * beat the day before them, in this habit's direction — "3 days getting
 * better in a row". Stops at the first non-logged day or the first day
 * that isn't an improvement. Needs at least 2 days to say anything. */
export function habitTrendStreak(s: HabitSummary): number {
  const series = s.series;
  let streak = 0;
  for (let i = series.length - 1; i > 0; i--) {
    const curr = series[i];
    const prev = series[i - 1];
    if (curr.total === 0 && prev.total === 0) break;
    if (isBetter(s.habit.direction, curr.total, prev.total) || curr.total === prev.total) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

export function weekOverWeekAvg(s: HabitSummary): { thisWeek: number; lastWeek: number } {
  const series = s.series;
  const thisWeekDays = series.slice(-7);
  const lastWeekDays = series.slice(-14, -7);
  const avg = (days: typeof series) => (days.length === 0 ? 0 : days.reduce((a, d) => a + d.total, 0) / days.length);
  return { thisWeek: avg(thisWeekDays), lastWeek: avg(lastWeekDays) };
}

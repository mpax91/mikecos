import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { type DateRange, type RangeKey, resolveRange, nyToday } from '../../utils/dateRange';

const KEYS: RangeKey[] = ['7d', '28d', '90d', 'ytd', '1y', 'all', 'custom'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** One date range shared by every tab of a dashboard page, kept in the URL
 * (`?r=90d`, or `?r=custom&from=…&to=…`) so switching tabs, reloading or
 * sharing the link keeps it (Mike, 2026-10-11). Other params are kept.
 * `earliest` resolves "All" for the page; a tab with a later start can
 * clamp with `clampRange`. */
export function useUrlRange(earliest: string, fallback: RangeKey = '28d'): [DateRange, (r: DateRange) => void] {
  const [params, setParams] = useSearchParams();
  const today = nyToday();
  const r = params.get('r') as RangeKey | null;
  const from = params.get('from');
  const to = params.get('to');
  const range = useMemo<DateRange>(() => {
    if (r === 'custom' && from && to && ISO.test(from) && ISO.test(to) && from <= to) return { key: 'custom', from, to, label: 'Custom' };
    const key = r && KEYS.includes(r) && r !== 'custom' ? r : fallback;
    return resolveRange(key, today, earliest);
  }, [r, from, to, today, earliest, fallback]);
  const setRange = useCallback(
    (next: DateRange) =>
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          p.delete('from');
          p.delete('to');
          if (next.key === fallback) p.delete('r');
          else p.set('r', next.key);
          if (next.key === 'custom') {
            p.set('from', next.from);
            p.set('to', next.to);
          }
          return p;
        },
        { replace: true },
      ),
    [setParams, fallback],
  );
  return [range, setRange];
}

/** "All" (or a range starting before a source existed) starts at that
 * source's first day instead. */
export function clampRange(r: DateRange, earliest: string): DateRange {
  if (r.key === 'all') return { ...r, from: earliest };
  return r;
}

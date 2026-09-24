import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { SearchGroupKey, SearchGroupResult, SearchResult } from '../api/types';
import { formatRelativeTime } from '../utils/formatRelativeTime';

// Fired by anything that wants to open the palette without importing it
// directly (the sidebar's search box) — kept as a plain window event
// rather than wiring this into TabsContext so the whole feature stays a
// single self-contained component, mounted once at the app root.
export const OPEN_SEARCH_EVENT = 'mikeos:open-search';

const GROUP_META: Record<SearchGroupKey, { label: string; icon: string }> = {
  notes: { label: 'Notes', icon: '📝' },
  jots: { label: 'Jots', icon: '🗒️' },
  lists: { label: 'Lists', icon: '☑️' },
  projects: { label: 'Projects', icon: '📁' },
  vault: { label: 'Vault', icon: '🗄️' },
  boards: { label: 'Boards', icon: '📌' },
  contacts: { label: 'Contacts', icon: '👤' },
  journal: { label: 'Journal', icon: '📔' },
  meeting_notes: { label: 'Meeting Notes', icon: '🗓️' },
  links: { label: 'Links', icon: '🔗' },
};
// Render order for results (includes Contacts); CHIP_GROUPS is the
// narrowing chip row and deliberately leaves Contacts out — see
// visibleGroups' comment for why it's a separate on/off checkbox instead.
const GROUP_ORDER: SearchGroupKey[] = ['notes', 'jots', 'lists', 'projects', 'vault', 'boards', 'contacts', 'journal', 'meeting_notes', 'links'];
const CHIP_GROUPS: SearchGroupKey[] = ['notes', 'jots', 'lists', 'projects', 'vault', 'boards', 'journal', 'meeting_notes', 'links'];
const DEFAULT_VISIBLE_PER_GROUP = 4;

/** Bolds every case-insensitive occurrence of `query` inside `text` —
 * that's the whole point of a snippet (showing *why* something matched),
 * so the highlight isn't optional polish. */
function highlight(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const q = query.trim();
  const lower = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let idx = lower.indexOf(lowerQ);
  while (idx !== -1) {
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(<mark key={idx}>{text.slice(idx, idx + q.length)}</mark>);
    i = idx + q.length;
    idx = lower.indexOf(lowerQ, i);
  }
  if (i < text.length) parts.push(text.slice(i));
  return parts;
}

interface FlatRow {
  result: SearchResult;
  group: SearchGroupKey;
}

export function SearchPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [groups, setGroups] = useState<SearchGroupResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeChips, setActiveChips] = useState<Set<SearchGroupKey>>(new Set());
  const [expanded, setExpanded] = useState<Set<SearchGroupKey>>(new Set());
  const [includeArchived, setIncludeArchived] = useState(false);
  const [includeContacts, setIncludeContacts] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);
  const requestSeq = useRef(0);

  const closePalette = useCallback(() => setOpen(false), []);

  const openPalette = useCallback(() => {
    setOpen(true);
    setActiveIndex(0);
    // Focus happens next tick, once the input actually exists in the DOM.
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  // Cmd/Ctrl+K toggles from anywhere; the sidebar search box asks via the
  // same window event a click on it fires.
  useEffect(() => {
    function onKeydown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((prev) => {
          if (!prev) setTimeout(() => inputRef.current?.focus(), 0);
          return !prev;
        });
      }
    }
    function onOpenEvent() {
      openPalette();
    }
    window.addEventListener('keydown', onKeydown);
    window.addEventListener(OPEN_SEARCH_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener('keydown', onKeydown);
      window.removeEventListener(OPEN_SEARCH_EVENT, onOpenEvent);
    };
  }, [openPalette]);

  // Always fetches every group (scope omitted) and lets the chips filter
  // client-side — toggling a chip is then instant instead of a re-fetch,
  // which is most of what makes this feel quick rather than laggy.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setGroups(null);
      setLoading(false);
      return;
    }
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      const seq = ++requestSeq.current;
      setLoading(true);
      api
        .search(q, [], includeArchived)
        .then((res) => {
          if (seq !== requestSeq.current) return; // a newer keystroke already superseded this response
          setGroups(res.groups);
          setExpanded(new Set());
          setActiveIndex(0);
        })
        .finally(() => {
          if (seq === requestSeq.current) setLoading(false);
        });
    }, 200);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [query, includeArchived, open]);

  const visibleGroups = useMemo(() => {
    if (!groups) return [];
    // Contacts is a separate on/off checkbox, not part of the chip
    // narrowing — there are enough contacts that including every hit by
    // default drowns out everything else, so it's off unless the checkbox
    // is checked. The other eight chips stay pure, uniform AND-narrowing:
    // no chips active shows everything (except Contacts); one or more
    // active narrows to just that selection.
    const filtered = groups.filter((g) => {
      if (g.key === 'contacts') return includeContacts;
      return activeChips.size === 0 || activeChips.has(g.key);
    });
    return GROUP_ORDER.map((key) => filtered.find((g) => g.key === key)).filter((g): g is SearchGroupResult => !!g && g.results.length > 0);
  }, [groups, activeChips, includeContacts]);

  const flatRows: FlatRow[] = useMemo(() => {
    const rows: FlatRow[] = [];
    for (const g of visibleGroups) {
      const limit = expanded.has(g.key) ? g.results.length : DEFAULT_VISIBLE_PER_GROUP;
      for (const r of g.results.slice(0, limit)) rows.push({ result: r, group: g.key });
    }
    return rows;
  }, [visibleGroups, expanded]);

  function toggleChip(key: SearchGroupKey) {
    setActiveChips((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setActiveIndex(0);
  }

  function openResult(r: SearchResult) {
    closePalette();
    navigate(r.path, r.openId ? { state: { openId: r.openId } } : undefined);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, flatRows.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const row = flatRows[activeIndex];
      if (row) openResult(row.result);
    }
  }

  if (!open) return null;

  const hasQuery = query.trim().length > 0;

  return (
    <div className="search-palette-backdrop" onClick={closePalette}>
      <div className="search-palette" onClick={(e) => e.stopPropagation()}>
        <div className="search-palette__input-row">
          <span className="search-palette__icon">🔍</span>
          <input
            ref={inputRef}
            className="search-palette__input"
            placeholder="Search everywhere…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="search-palette__esc">esc</kbd>
        </div>

        <div className="search-palette__chips">
          {CHIP_GROUPS.map((key) => (
            <button
              key={key}
              type="button"
              className={`search-palette__chip${activeChips.has(key) ? ' is-active' : ''}`}
              onClick={() => toggleChip(key)}
            >
              {GROUP_META[key].icon} {GROUP_META[key].label}
            </button>
          ))}
          <div className="search-palette__toggles">
            <label className="search-palette__archived-toggle">
              <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
              Archived/completed
            </label>
            <label className="search-palette__archived-toggle">
              <input type="checkbox" checked={includeContacts} onChange={(e) => setIncludeContacts(e.target.checked)} />
              Contacts
            </label>
          </div>
        </div>

        <div className="search-palette__results">
          {!hasQuery && <div className="search-palette__hint">Start typing to search everything — or tap a category above to narrow first.</div>}
          {hasQuery && loading && !groups && <div className="search-palette__hint">Searching…</div>}
          {hasQuery && !loading && groups && flatRows.length === 0 && <div className="search-palette__hint">No results for "{query.trim()}".</div>}
          {visibleGroups.map((g) => {
            const limit = expanded.has(g.key) ? g.results.length : DEFAULT_VISIBLE_PER_GROUP;
            const shown = g.results.slice(0, limit);
            return (
              <div className="search-palette__group" key={g.key}>
                <div className="search-palette__group-label">
                  {GROUP_META[g.key].icon} {GROUP_META[g.key].label}
                </div>
                {shown.map((r) => {
                  const flatIndex = flatRows.findIndex((row) => row.result === r);
                  const isActive = flatIndex === activeIndex;
                  return (
                    <div
                      key={r.id}
                      className={`search-palette__result${isActive ? ' is-active' : ''}`}
                      onMouseEnter={() => setActiveIndex(flatIndex)}
                      onClick={() => openResult(r)}
                    >
                      <div className="search-palette__result-main">
                        <span className="search-palette__result-title">{highlight(r.title, query)}</span>
                        {r.parentTitle && <span className="search-palette__result-parent">in {r.parentTitle}</span>}
                      </div>
                      {r.snippet && <div className="search-palette__result-snippet">{highlight(r.snippet, query)}</div>}
                      <span className="search-palette__result-time">{formatRelativeTime(r.updatedAt)}</span>
                    </div>
                  );
                })}
                {g.results.length > DEFAULT_VISIBLE_PER_GROUP && !expanded.has(g.key) && (
                  <button
                    type="button"
                    className="search-palette__see-all"
                    onClick={() => setExpanded((prev) => new Set(prev).add(g.key))}
                  >
                    See {g.results.length - DEFAULT_VISIBLE_PER_GROUP} more in {GROUP_META[g.key].label}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

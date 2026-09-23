import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { BetGameNote, BetPromo, BetScheduleGame } from '../api/types';
import { SPORTS, formatMoney, type SportsbookBalance } from '../utils/bets';
import { Modal } from './Modal';

function todayLocalISODash(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftDate(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function formatKickoff(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

const COLUMNS_KEY = 'mikeos-bets-workspace-columns';
const COLLAPSED_KEY = 'mikeos-bets-workspace-collapsed';
// Mike's default tipper roster — matches the "Tipper" tab of his old sheet,
// swapping out the two he doesn't use anymore (Sportsline, CBS Props) for
// ChatGPT and Claude. Only applied the very first time (nothing saved yet);
// once he edits his columns, localStorage takes over.
const DEFAULT_COLUMNS = ['EPH', 'yLose', 'Walter', 'ChatGPT', 'Claude'];

// Best Bets uses its own fixed set of columns, separate from the day's
// tipper columns above — once a game is starred it's no longer "what do my
// tipsters think", it's "which book has the best number right now". Matches
// the "Sportsbooks" tab of Mike's old sheet. Not renameable — these are real
// sportsbook names that Banking/Promos also key off of.
const SPORTSBOOK_COLUMNS = ['BetMGM', 'BetRivers', 'DraftKings', 'FanDuel', 'Caesars'];

function loadStringList(key: string, fallback: string[] = []): string[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as string[]) : fallback;
  } catch {
    return fallback;
  }
}

function saveStringList(key: string, list: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* best-effort — a per-browser convenience, not durable data */
  }
}

/** A row on the board — merged from the auto-pulled schedule (ESPN for
 * NFL/NBA/NCAAF — D1/FBS only, via groups=80; MLB's and the NHL's own
 * official APIs for those two — see the worker's comment above GET
 * /api/bets/games for why they're split) and whatever's already saved in
 * bet_game_notes for this date. `noteId` is null until the first save, at
 * which point a real BetGameNote gets created — this is what lets "today's
 * games" show up with nothing to click through first. */
interface BoardEntry {
  key: string;
  noteId: string | null;
  sport: string;
  externalId: string | null;
  matchup: string;
  startTime: string | null;
  note: string;
  pinned: boolean;
  cells: Map<string, string>; // source -> value, e.g. 'DraftKings' -> '-6.5 (-110)', 'EPH' -> 'SEA -6.5'
}

function entryFromSchedule(g: BetScheduleGame, match: BetGameNote | undefined): BoardEntry {
  return {
    key: match?.id ?? `sched:${g.sport}:${g.external_id}`,
    noteId: match?.id ?? null,
    sport: g.sport,
    externalId: g.external_id,
    matchup: match?.matchup ?? g.matchup,
    startTime: match?.start_time ?? g.start_time,
    note: match?.note ?? '',
    pinned: !!match?.pinned,
    cells: new Map((match?.lines ?? []).map((l) => [l.sportsbook, l.line])),
  };
}

function entryFromNote(n: BetGameNote): BoardEntry {
  return {
    key: n.id,
    noteId: n.id,
    sport: n.sport,
    externalId: n.external_id,
    matchup: n.matchup,
    startTime: n.start_time,
    note: n.note ?? '',
    pinned: !!n.pinned,
    cells: new Map(n.lines.map((l) => [l.sportsbook, l.line])),
  };
}

/** Pulls the last American-odds-looking token out of a free-typed cell
 * ("SEA -6.5 (-110)" -> -110, "-107" -> -107) so Best Bets can highlight the
 * best price across books without forcing a rigid input format. A cell
 * that isn't odds at all (a spread-only note, or blank) just doesn't
 * participate in the comparison. */
function parseAmericanOdds(value: string): number | null {
  const matches = value.match(/[-+]\d{2,5}(?!\d)/g);
  if (!matches || matches.length === 0) return null;
  const n = Number(matches[matches.length - 1]);
  return Number.isFinite(n) ? n : null;
}

/** Which of a row's sportsbook cells currently show the best price — on the
 * American-odds scale, higher is always better (-107 beats -115, +150 beats
 * -110), so it's a single max across whatever cells parse as odds. Ties all
 * get marked. */
function bestOddsColumns(entry: BoardEntry, cols: string[]): Set<string> {
  let best: number | null = null;
  const parsed = new Map<string, number>();
  for (const col of cols) {
    const n = parseAmericanOdds(entry.cells.get(col) ?? '');
    if (n == null) continue;
    parsed.set(col, n);
    if (best == null || n > best) best = n;
  }
  const winners = new Set<string>();
  if (best == null) return winners;
  for (const [col, n] of parsed) if (n === best) winners.add(col);
  return winners;
}

function NotesModal({
  entry,
  onClose,
  onSave,
  onRemove,
}: {
  entry: BoardEntry;
  onClose: () => void;
  onSave: (note: string) => Promise<void>;
  onRemove: (() => Promise<void>) | null;
}) {
  const [note, setNote] = useState(entry.note);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(note);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    if (!onRemove) return;
    setRemoving(true);
    try {
      await onRemove();
      onClose();
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Modal title={entry.matchup} onClose={onClose}>
      <div className="bets-form">
        <label className="bets-form__field">
          <span>Notes — bets you like, reasoning, anything</span>
          <textarea rows={5} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. SEA -6.5 looks soft, CAR getting too many points" />
        </label>
      </div>
      <div className="modal__actions">
        {onRemove && (
          <button type="button" className="btn btn--ghost bets-workspace__modal-remove" onClick={handleRemove} disabled={saving || removing}>
            {removing ? 'Removing…' : 'Remove game'}
          </button>
        )}
        <button className="btn btn--ghost" onClick={onClose} disabled={saving || removing}>
          Cancel
        </button>
        <button className="btn" onClick={handleSave} disabled={saving || removing}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

function AddGameModal({ date, onClose, onAdd }: { date: string; onClose: () => void; onAdd: (params: { sport: string; matchup: string }) => Promise<void> }) {
  const [sport, setSport] = useState(SPORTS[0]);
  const [matchup, setMatchup] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!matchup.trim()) return setError('Matchup is required, e.g. "DUKE @ UNC".');
    setSaving(true);
    setError(null);
    try {
      await onAdd({ sport, matchup: matchup.trim() });
      onClose();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  return (
    <Modal title={`Add a game — ${date}`} onClose={onClose}>
      <div className="bets-form">
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
          <span>Matchup</span>
          <input placeholder="DUKE @ UNC" value={matchup} onChange={(e) => setMatchup(e.target.value)} />
        </label>
        {error && <div className="bets-form__error">{error}</div>}
      </div>
      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button className="btn" onClick={handleSave} disabled={saving}>
          {saving ? 'Adding…' : 'Add Game'}
        </button>
      </div>
    </Modal>
  );
}

/** One editable cell — local draft state so typing doesn't fire a save on
 * every keystroke; commits on blur/Enter, and only if the value actually
 * changed. */
function CellInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="bets-workspace__cell-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      placeholder="—"
    />
  );
}

/** A column header that doubles as an inline rename field — click the label
 * to edit it, blur/Enter commits. Only used for the day's tipper columns;
 * Best Bets' sportsbook columns are a fixed list and aren't renameable. */
function ColumnHeaderCell({ name, onRename }: { name: string; onRename: (oldName: string, newName: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) onRename(name, trimmed);
    else setDraft(name);
  }

  if (!editing) {
    return (
      <th className="bets-workspace__col-th">
        <button type="button" className="bets-workspace__col-th-btn" onClick={() => setEditing(true)} title="Click to rename this column">
          {name}
        </button>
      </th>
    );
  }
  return (
    <th className="bets-workspace__col-th">
      <input
        autoFocus
        className="bets-workspace__col-th-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setDraft(name);
            setEditing(false);
          }
        }}
      />
    </th>
  );
}

function GameRow({
  entry,
  columns,
  showSport,
  bestCols,
  promoCols,
  onCellCommit,
  onPinToggle,
  onOpenNotes,
}: {
  entry: BoardEntry;
  columns: string[];
  showSport: boolean;
  bestCols?: Set<string>;
  promoCols?: Set<string>;
  onCellCommit: (entry: BoardEntry, source: string, value: string) => void;
  onPinToggle: (entry: BoardEntry) => void;
  onOpenNotes: (entry: BoardEntry) => void;
}) {
  return (
    <tr className={entry.pinned ? 'is-pinned' : undefined}>
      <td className="bets-workspace__pin-cell">
        <button type="button" className={`bets-workspace__pin-btn${entry.pinned ? ' is-active' : ''}`} onClick={() => onPinToggle(entry)} title={entry.pinned ? 'Unpin' : 'Pin as a best bet'}>
          {entry.pinned ? '★' : '☆'}
        </button>
      </td>
      {showSport && <td className="bets-workspace__sport-cell">{entry.sport}</td>}
      <td className="bets-workspace__matchup-cell">{entry.matchup}</td>
      <td className="bets-workspace__time-cell">{formatKickoff(entry.startTime)}</td>
      {columns.map((col) => (
        <td key={col} className={bestCols?.has(col) ? 'bets-workspace__cell--best' : undefined}>
          <div className="bets-workspace__cell-wrap">
            <CellInput value={entry.cells.get(col) ?? ''} onCommit={(v) => onCellCommit(entry, col, v)} />
            {promoCols?.has(col) && (
              <span className="bets-workspace__promo-flag" title={`Active promo at ${col} — double-check it actually applies to this bet (odds/legs, straight vs. parlay can matter)`}>
                🔥
              </span>
            )}
          </div>
        </td>
      ))}
      <td className="bets-workspace__notes-cell">
        <button type="button" className={`bets-workspace__notes-btn${entry.note ? ' has-note' : ''}`} onClick={() => onOpenNotes(entry)} title={entry.note || 'Add notes'}>
          {entry.note ? '📝' : '+ note'}
        </button>
      </td>
    </tr>
  );
}

function SportSection({
  sport,
  entries,
  columns,
  collapsed,
  onToggleCollapse,
  onCellCommit,
  onPinToggle,
  onOpenNotes,
  onRenameColumn,
}: {
  sport: string;
  entries: BoardEntry[];
  columns: string[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  onCellCommit: (entry: BoardEntry, source: string, value: string) => void;
  onPinToggle: (entry: BoardEntry) => void;
  onOpenNotes: (entry: BoardEntry) => void;
  onRenameColumn: (oldName: string, newName: string) => void;
}) {
  return (
    <div className="bets-workspace__section card">
      <button type="button" className="bets-workspace__section-header" onClick={onToggleCollapse}>
        <span className={`bets-workspace__chevron${collapsed ? ' is-collapsed' : ''}`}>▾</span>
        <span className="bets-workspace__section-title">{sport}</span>
        <span className="bets-workspace__section-count">{entries.length}</span>
      </button>
      {!collapsed && (
        <div className="bets-workspace__table-wrap">
          <table className="bets-workspace__table">
            <thead>
              <tr>
                <th />
                <th className="bets-workspace__game-th">Game</th>
                <th className="bets-workspace__time-th">Time</th>
                {columns.map((col) => (
                  <ColumnHeaderCell key={col} name={col} onRename={onRenameColumn} />
                ))}
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <GameRow key={entry.key} entry={entry} columns={columns} showSport={false} onCellCommit={onCellCommit} onPinToggle={onPinToggle} onOpenNotes={onOpenNotes} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function BetsWorkspaceTab({ balances, promos }: { balances: SportsbookBalance[]; promos: BetPromo[] }) {
  const [date, setDate] = useState(todayLocalISODash());
  const [schedule, setSchedule] = useState<BetScheduleGame[] | null>(null);
  const [notes, setNotes] = useState<BetGameNote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notesFor, setNotesFor] = useState<BoardEntry | null>(null);
  const [adding, setAdding] = useState(false);
  const [columns, setColumns] = useState<string[]>(() => loadStringList(`${COLUMNS_KEY}:${todayLocalISODash()}`, loadStringList(COLUMNS_KEY, DEFAULT_COLUMNS)));
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColumnName, setNewColumnName] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(loadStringList(COLLAPSED_KEY)));
  const [clearedSnapshot, setClearedSnapshot] = useState<BetGameNote[] | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    setSchedule(null);
    setNotes(null);
    setError(null);
    setClearedSnapshot(null);
    setSearch('');
    // A date that's had its own columns saved (via rename/add while viewing
    // it) keeps that snapshot forever; any other date just tracks whatever
    // the current base default is.
    setColumns(loadStringList(`${COLUMNS_KEY}:${date}`, loadStringList(COLUMNS_KEY, DEFAULT_COLUMNS)));
    Promise.all([api.getBetScheduleGames(date), api.listBetGameNotes(date)])
      .then(([sched, n]) => {
        setSchedule(sched);
        setNotes(n);
      })
      .catch((e) => setError(String(e)));
  }, [date]);

  // Auto-dismiss the "Cleared — Undo" banner after a while so it doesn't
  // linger forever if Mike doesn't touch it.
  useEffect(() => {
    if (!clearedSnapshot) return;
    const t = setTimeout(() => setClearedSnapshot(null), 15000);
    return () => clearTimeout(t);
  }, [clearedSnapshot]);

  const entries: BoardEntry[] = useMemo(() => {
    if (!schedule || !notes) return [];
    const byExternal = new Map(notes.filter((n) => n.external_id).map((n) => [`${n.sport}:${n.external_id}`, n]));
    const usedNoteIds = new Set<string>();
    const list: BoardEntry[] = schedule.map((g) => {
      const match = byExternal.get(`${g.sport}:${g.external_id}`);
      if (match) usedNoteIds.add(match.id);
      return entryFromSchedule(g, match);
    });
    // Saved notes that didn't match a currently-scheduled game (manually
    // added games, or a schedule fetch that came back thin) still belong
    // on the board.
    for (const n of notes) {
      if (usedNoteIds.has(n.id)) continue;
      list.push(entryFromNote(n));
    }
    return list.sort((a, b) => {
      if (a.startTime && b.startTime) return a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0;
      if (a.startTime) return -1;
      if (b.startTime) return 1;
      return a.matchup.localeCompare(b.matchup);
    });
  }, [schedule, notes]);

  /** Saves a new effective column list for the currently-viewed date, and
   * — only when that date is today — also updates the base default that a
   * brand-new date starts from. That's the whole "future days default to
   * what we set up today, but editing a given day only holds for that day"
   * rule: a date that's never had this called for it just keeps tracking
   * the live base default (see the `date` effect above), so renaming
   * today's columns doesn't retroactively rewrite some day Mike already
   * looked at and left alone. */
  function persistColumnsForDate(next: string[]) {
    setColumns(next);
    saveStringList(`${COLUMNS_KEY}:${date}`, next);
    if (date === todayLocalISODash()) saveStringList(COLUMNS_KEY, next);
  }

  // Any source that already has data today stays a visible column even if
  // it was never explicitly added this browser — grown into `columns` (and
  // persisted for this date) rather than shown only transiently, so it's
  // still there next time regardless of which device added it.
  useEffect(() => {
    if (!notes) return;
    const used = new Set<string>();
    for (const n of notes) for (const l of n.lines) used.add(l.sportsbook);
    const missing = [...used].filter((s) => !columns.includes(s));
    if (missing.length > 0) persistColumnsForDate([...columns, ...missing]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  // With five leagues now pulling in, a full slate can run 100+ rows across
  // sections — search matches matchup, sport, notes, and any tip/line
  // already typed into a cell, so "which game did EPH like" works too, not
  // just team names.
  const searchQuery = search.trim().toLowerCase();
  const visibleEntries = searchQuery
    ? entries.filter((e) => {
        const haystack = [e.matchup, e.sport, e.note, ...e.cells.values()].join(' ').toLowerCase();
        return haystack.includes(searchQuery);
      })
    : entries;

  const pinned = visibleEntries.filter((e) => e.pinned);
  const bySport = new Map<string, BoardEntry[]>();
  for (const e of visibleEntries) {
    if (e.pinned) continue;
    const list = bySport.get(e.sport) ?? [];
    list.push(e);
    bySport.set(e.sport, list);
  }

  async function persist(entry: BoardEntry, patch: Partial<{ note: string; pinned: boolean; cells: Map<string, string> }>) {
    const nextNote = patch.note ?? entry.note;
    const nextPinned = patch.pinned ?? entry.pinned;
    const nextCells = patch.cells ?? entry.cells;
    const lines = [...nextCells.entries()].filter(([, v]) => v.trim()).map(([sportsbook, line]) => ({ sportsbook, line }));
    if (entry.noteId) {
      const updated = await api.updateBetGameNote(entry.noteId, { note: nextNote, pinned: nextPinned, lines });
      setNotes((prev) => (prev ? prev.map((n) => (n.id === updated.id ? updated : n)) : prev));
    } else {
      const created = await api.createBetGameNote({
        date,
        sport: entry.sport,
        external_id: entry.externalId,
        matchup: entry.matchup,
        start_time: entry.startTime,
        note: nextNote,
        pinned: nextPinned,
        lines,
      });
      setNotes((prev) => [...(prev ?? []), created]);
    }
  }

  function handleCellCommit(entry: BoardEntry, source: string, value: string) {
    const nextCells = new Map(entry.cells);
    if (value.trim()) nextCells.set(source, value.trim());
    else nextCells.delete(source);
    persist(entry, { cells: nextCells });
  }

  function handlePinToggle(entry: BoardEntry) {
    persist(entry, { pinned: !entry.pinned });
  }

  async function handleNotesSave(entry: BoardEntry, note: string) {
    await persist(entry, { note });
  }

  async function handleRemove(entry: BoardEntry) {
    if (!entry.noteId) return;
    await api.deleteBetGameNote(entry.noteId);
    setNotes((prev) => (prev ? prev.filter((n) => n.id !== entry.noteId) : prev));
  }

  async function addManualGame(params: { sport: string; matchup: string }) {
    const created = await api.createBetGameNote({ date, sport: params.sport, matchup: params.matchup, note: '', pinned: false, lines: [] });
    setNotes((prev) => [...(prev ?? []), created]);
  }

  function toggleCollapse(sport: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(sport)) next.delete(sport);
      else next.add(sport);
      saveStringList(COLLAPSED_KEY, [...next]);
      return next;
    });
  }

  function commitNewColumn() {
    const name = newColumnName.trim();
    if (name && !columns.includes(name)) persistColumnsForDate([...columns, name]);
    setNewColumnName('');
    setAddingColumn(false);
  }

  /** Renames a tipper column and migrates any already-saved cells for this
   * date from the old key to the new one, so existing tips don't silently
   * vanish under the old header name. */
  async function handleRenameColumn(oldName: string, newName: string) {
    if (columns.includes(newName)) return; // don't collide with an existing column
    persistColumnsForDate(columns.map((c) => (c === oldName ? newName : c)));
    const affected = entries.filter((e) => e.cells.has(oldName));
    await Promise.all(
      affected.map((entry) => {
        const nextCells = new Map(entry.cells);
        const value = nextCells.get(oldName)!;
        nextCells.delete(oldName);
        nextCells.set(newName, value);
        return persist(entry, { cells: nextCells });
      })
    );
  }

  async function handleClearAll() {
    if (!notes || notes.length === 0) return;
    const snapshot = notes;
    setNotes([]);
    setClearedSnapshot(snapshot);
    try {
      await Promise.all(snapshot.map((n) => api.deleteBetGameNote(n.id)));
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleUndoClear() {
    if (!clearedSnapshot) return;
    const toRestore = clearedSnapshot;
    setClearedSnapshot(null);
    const restored = await Promise.all(
      toRestore.map((n) =>
        api.createBetGameNote({
          date: n.date,
          sport: n.sport,
          external_id: n.external_id,
          matchup: n.matchup,
          start_time: n.start_time,
          note: n.note ?? '',
          pinned: !!n.pinned,
          lines: n.lines.map((l) => ({ sportsbook: l.sportsbook, line: l.line })),
        })
      )
    );
    setNotes((prev) => [...(prev ?? []), ...restored]);
  }

  const activePromos = promos.filter((p) => p.status === 'active' && (!p.expires_at || p.expires_at >= date));
  // Boost-availability is flagged per sportsbook only — a promo carries no
  // sport of its own (see BetPromo), and matching a promo's odds/legs
  // against a specific game is unreliable for anything but a plain straight
  // bet (a promo boost tied to a parlay can look like it applies to one leg
  // in isolation when it really doesn't). So this is a "check this book"
  // nudge, not an auto-verified match — the tooltip says as much.
  const promoSportsbooks = new Set(activePromos.map((p) => p.sportsbook));
  const balanceBySportsbook = new Map(balances.map((b) => [b.sportsbook, b.balance]));
  const loading = schedule === null || notes === null;
  const sportKeys = [...bySport.keys()].sort();

  return (
    <div className="bets-workspace">
      {balances.length > 0 && (
        <div className="bets-workspace__balances">
          {balances.map((b) => (
            <div key={b.sportsbook} className="bets-workspace__balance-chip">
              <span>{b.sportsbook}</span>
              <span className={b.balance >= 0 ? 'is-up' : 'is-down'}>{formatMoney(b.balance)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="toolbar-row">
        <div className="dashboard-page__period-pill">
          <button type="button" className="dashboard-page__nav-btn" onClick={() => setDate((d) => shiftDate(d, -1))} aria-label="Previous day">
            ‹
          </button>
          <span className="dashboard-page__period-label">
            <span className="dashboard-page__period-main">
              {new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
            </span>
          </span>
          <button type="button" className="dashboard-page__nav-btn" onClick={() => setDate((d) => shiftDate(d, 1))} aria-label="Next day">
            ›
          </button>
        </div>
        {date !== todayLocalISODash() && (
          <button type="button" className="chip" onClick={() => setDate(todayLocalISODash())}>
            Jump to today
          </button>
        )}
        <input
          type="search"
          className="bets-workspace__search"
          placeholder="Search games, notes, tips…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="bets-workspace__column-add">
          {addingColumn ? (
            <div className="bets-workspace__column-add-input">
              <input
                autoFocus
                placeholder="New tipper column…"
                value={newColumnName}
                onChange={(e) => setNewColumnName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitNewColumn();
                  if (e.key === 'Escape') {
                    setAddingColumn(false);
                    setNewColumnName('');
                  }
                }}
                onBlur={commitNewColumn}
              />
            </div>
          ) : (
            <button type="button" className="chip" onClick={() => setAddingColumn(true)}>
              + Add column
            </button>
          )}
        </div>
        {notes && notes.length > 0 && (
          <button type="button" className="chip" onClick={handleClearAll} title="Delete every saved note/tip/pin for this date">
            Clear All
          </button>
        )}
        <button className="btn" onClick={() => setAdding(true)}>
          + Add Game
        </button>
      </div>

      {clearedSnapshot && (
        <div className="bets-workspace__undo-banner">
          <span>
            Cleared {clearedSnapshot.length} game{clearedSnapshot.length === 1 ? '' : 's'} for {date}.
          </span>
          <button type="button" className="chip" onClick={handleUndoClear}>
            Undo
          </button>
        </div>
      )}

      {activePromos.length > 0 && (
        <div className="bets-breakdown card" style={{ marginTop: 12 }}>
          <div className="bets-breakdown__title">Promos available today</div>
          <div className="bets-workspace__promo-chips">
            {activePromos.map((p) => (
              <div key={p.id} className="bets-workspace__promo-chip">
                <strong>{p.sportsbook}</strong> {p.description}
                {p.odds ? ` · ${p.odds}` : ''}
                {p.amount ? ` · ${p.amount}` : ''}
              </div>
            ))}
          </div>
        </div>
      )}

      {error && <div className="empty-state">Couldn't load today's games: {error}</div>}
      {loading && !error && <div className="empty-state">Loading games…</div>}

      {!loading && !error && entries.length === 0 && (
        <div className="empty-state">No NFL, NCAAF, NBA, MLB, or NHL games found for this date. Add one manually if something else is on your slate.</div>
      )}

      {!loading && !error && entries.length > 0 && searchQuery && visibleEntries.length === 0 && (
        <div className="empty-state">No games, notes, or tips match "{search.trim()}".</div>
      )}

      {!loading && pinned.length > 0 && (
        <div className="bets-workspace__section bets-workspace__section--pinned card">
          <div className="bets-workspace__section-header">
            <span className="bets-workspace__section-title">★ Best Bets</span>
            <span className="bets-workspace__section-count">{pinned.length}</span>
          </div>
          <div className="bets-workspace__table-wrap">
            <table className="bets-workspace__table">
              <thead>
                <tr>
                  <th />
                  <th>Sport</th>
                  <th className="bets-workspace__game-th">Game</th>
                  <th className="bets-workspace__time-th">Time</th>
                  {SPORTSBOOK_COLUMNS.map((col) => (
                    <th key={col}>{col}</th>
                  ))}
                  <th>Notes</th>
                </tr>
                {balances.length > 0 && (
                  <tr className="bets-workspace__balance-row">
                    <th colSpan={4} className="bets-workspace__balance-row-label">
                      Balance
                    </th>
                    {SPORTSBOOK_COLUMNS.map((col) => (
                      <th key={col}>{balanceBySportsbook.has(col) ? formatMoney(balanceBySportsbook.get(col)!) : '—'}</th>
                    ))}
                    <th />
                  </tr>
                )}
              </thead>
              <tbody>
                {pinned.map((entry) => (
                  <GameRow
                    key={entry.key}
                    entry={entry}
                    columns={SPORTSBOOK_COLUMNS}
                    showSport
                    bestCols={bestOddsColumns(entry, SPORTSBOOK_COLUMNS)}
                    promoCols={promoSportsbooks}
                    onCellCommit={handleCellCommit}
                    onPinToggle={handlePinToggle}
                    onOpenNotes={setNotesFor}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading &&
        sportKeys.map((sport) => (
          <SportSection
            key={sport}
            sport={sport}
            entries={bySport.get(sport) ?? []}
            columns={columns}
            collapsed={!searchQuery && collapsed.has(sport)}
            onToggleCollapse={() => toggleCollapse(sport)}
            onCellCommit={handleCellCommit}
            onPinToggle={handlePinToggle}
            onOpenNotes={setNotesFor}
            onRenameColumn={handleRenameColumn}
          />
        ))}

      {notesFor && (
        <NotesModal
          entry={notesFor}
          onClose={() => setNotesFor(null)}
          onSave={(note) => handleNotesSave(notesFor, note)}
          onRemove={notesFor.noteId ? () => handleRemove(notesFor) : null}
        />
      )}
      {adding && <AddGameModal date={date} onClose={() => setAdding(false)} onAdd={addManualGame} />}
    </div>
  );
}

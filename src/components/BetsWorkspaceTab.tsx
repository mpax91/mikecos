import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { BetGameLine, BetGameNote, BetPromo, BetScheduleGame } from '../api/types';
import { COMMON_SPORTSBOOKS, SPORTS, formatMoney, type SportsbookBalance } from '../utils/bets';
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

/** A row on the board — merged from the auto-pulled ESPN schedule and
 * whatever's already saved in bet_game_notes for this date. `noteId` is
 * null until the first save, at which point a real BetGameNote gets
 * created (see save() below) — this is what lets "today's games" show up
 * with nothing to click through first. */
interface BoardEntry {
  key: string;
  noteId: string | null;
  sport: string;
  externalId: string | null;
  matchup: string;
  startTime: string | null;
  note: string;
  pinned: boolean;
  lines: { sportsbook: string; line: string }[];
}

type LineDraft = { sportsbook: string; line: string };

function GameFormModal({ entry, onClose, onSave, onRemove }: { entry: BoardEntry; onClose: () => void; onSave: (params: { note: string; pinned: boolean; lines: LineDraft[] }) => Promise<void>; onRemove: (() => Promise<void>) | null }) {
  const [note, setNote] = useState(entry.note);
  const [pinned, setPinned] = useState(entry.pinned);
  const [lines, setLines] = useState<LineDraft[]>(entry.lines.length > 0 ? entry.lines : [{ sportsbook: '', line: '' }]);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  function updateLine(i: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((prev) => [...prev, { sportsbook: '', line: '' }]);
  }
  function removeLine(i: number) {
    setLines((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function handleSave() {
    setSaving(true);
    try {
      await onSave({ note, pinned, lines: lines.filter((l) => l.sportsbook.trim() && l.line.trim()) });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={entry.matchup} onClose={onClose}>
      <div className="bets-form">
        <label className="bets-form__field bets-form__field--checkbox">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
          <span>Pin to top (best bet)</span>
        </label>

        <div className="bets-legs">
          <div className="bets-legs__title">Lines by sportsbook</div>
          {lines.map((l, i) => (
            <div key={i} className="bets-workspace__line-row">
              <input list="bets-sportsbooks-line" placeholder="Sportsbook" value={l.sportsbook} onChange={(e) => updateLine(i, { sportsbook: e.target.value })} />
              <datalist id="bets-sportsbooks-line">
                {COMMON_SPORTSBOOKS.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
              <input placeholder="Chiefs -3.5 (-110)" value={l.line} onChange={(e) => updateLine(i, { line: e.target.value })} />
              <button type="button" className="bets-legs__remove" onClick={() => removeLine(i)} aria-label="Remove line">
                ✕
              </button>
            </div>
          ))}
          <button type="button" className="link-btn" onClick={addLine}>
            + Add line
          </button>
        </div>

        <label className="bets-form__field">
          <span>Notes — bets you like, reasoning, anything</span>
          <textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. SEA -6.5 looks soft, CAR getting too many points" />
        </label>
      </div>
      <div className="modal__actions">
        {onRemove && (
          <button
            className="btn btn--ghost"
            style={{ marginRight: 'auto' }}
            disabled={removing || saving}
            onClick={async () => {
              setRemoving(true);
              await onRemove();
              onClose();
            }}
          >
            {removing ? 'Removing…' : 'Remove'}
          </button>
        )}
        <button className="btn btn--ghost" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button className="btn" onClick={handleSave} disabled={saving}>
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
    if (!matchup.trim()) return setError('Matchup is required, e.g. "Duke @ UNC".');
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
          <input placeholder="Duke @ UNC" value={matchup} onChange={(e) => setMatchup(e.target.value)} />
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

export function BetsWorkspaceTab({ balances, promos }: { balances: SportsbookBalance[]; promos: BetPromo[] }) {
  const [date, setDate] = useState(todayLocalISODash());
  const [schedule, setSchedule] = useState<BetScheduleGame[] | null>(null);
  const [notes, setNotes] = useState<BetGameNote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<BoardEntry | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    setSchedule(null);
    setNotes(null);
    setError(null);
    Promise.all([api.getBetScheduleGames(date), api.listBetGameNotes(date)])
      .then(([sched, n]) => {
        setSchedule(sched);
        setNotes(n);
      })
      .catch((e) => setError(String(e)));
  }, [date]);

  const entries: BoardEntry[] = useMemo(() => {
    if (!schedule || !notes) return [];
    const byExternal = new Map(notes.filter((n) => n.external_id).map((n) => [`${n.sport}:${n.external_id}`, n]));
    const usedNoteIds = new Set<string>();
    const list: BoardEntry[] = schedule.map((g) => {
      const match = byExternal.get(`${g.sport}:${g.external_id}`);
      if (match) usedNoteIds.add(match.id);
      return {
        key: match?.id ?? `sched:${g.sport}:${g.external_id}`,
        noteId: match?.id ?? null,
        sport: g.sport,
        externalId: g.external_id,
        matchup: match?.matchup ?? g.matchup,
        startTime: match?.start_time ?? g.start_time,
        note: match?.note ?? '',
        pinned: !!match?.pinned,
        lines: (match?.lines ?? []).map((l: BetGameLine) => ({ sportsbook: l.sportsbook, line: l.line })),
      };
    });
    // Saved notes that didn't match a currently-scheduled game (manually
    // added games, or a schedule fetch that came back thin) still belong
    // on the board — append them too.
    for (const n of notes) {
      if (usedNoteIds.has(n.id)) continue;
      list.push({
        key: n.id,
        noteId: n.id,
        sport: n.sport,
        externalId: n.external_id,
        matchup: n.matchup,
        startTime: n.start_time,
        note: n.note ?? '',
        pinned: !!n.pinned,
        lines: n.lines.map((l) => ({ sportsbook: l.sportsbook, line: l.line })),
      });
    }
    return list.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.startTime && b.startTime) return a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0;
      if (a.startTime) return -1;
      if (b.startTime) return 1;
      return a.matchup.localeCompare(b.matchup);
    });
  }, [schedule, notes]);

  async function saveEntry(entry: BoardEntry, params: { note: string; pinned: boolean; lines: LineDraft[] }) {
    if (entry.noteId) {
      const updated = await api.updateBetGameNote(entry.noteId, params);
      setNotes((prev) => (prev ? prev.map((n) => (n.id === updated.id ? updated : n)) : prev));
    } else {
      const created = await api.createBetGameNote({
        date,
        sport: entry.sport,
        external_id: entry.externalId,
        matchup: entry.matchup,
        start_time: entry.startTime,
        ...params,
      });
      setNotes((prev) => [...(prev ?? []), created]);
    }
  }

  async function removeEntry(entry: BoardEntry) {
    if (!entry.noteId) return;
    await api.deleteBetGameNote(entry.noteId);
    setNotes((prev) => (prev ? prev.filter((n) => n.id !== entry.noteId) : prev));
  }

  async function addManualGame(params: { sport: string; matchup: string }) {
    const created = await api.createBetGameNote({ date, sport: params.sport, matchup: params.matchup, note: '', pinned: false, lines: [] });
    setNotes((prev) => [...(prev ?? []), created]);
  }

  const activePromos = promos.filter((p) => p.status === 'active' && (!p.expires_at || p.expires_at >= date));
  const loading = schedule === null || notes === null;

  return (
    <div>
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
        <button className="btn" onClick={() => setAdding(true)}>
          + Add Game
        </button>
      </div>

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
        <div className="empty-state">No NFL, NBA, MLB, or NHL games found for this date. Add one manually if something else is on your slate.</div>
      )}

      {!loading && entries.length > 0 && (
        <div className="bets-workspace__board">
          {entries.map((entry) => (
            <button key={entry.key} type="button" className={`bets-workspace__game card${entry.pinned ? ' is-pinned' : ''}`} onClick={() => setEditing(entry)}>
              <div className="bets-workspace__game-head">
                <span className="bets-workspace__game-sport">{entry.sport}</span>
                {entry.startTime && <span className="bets-workspace__game-time">{formatKickoff(entry.startTime)}</span>}
                {entry.pinned && <span className="bets-workspace__game-pin" title="Pinned">★</span>}
              </div>
              <div className="bets-workspace__game-matchup">{entry.matchup}</div>
              {entry.lines.length > 0 && (
                <div className="bets-workspace__game-lines">{entry.lines.map((l) => `${l.sportsbook}: ${l.line}`).join(' · ')}</div>
              )}
              {entry.note && <div className="bets-workspace__game-note">{entry.note}</div>}
            </button>
          ))}
        </div>
      )}

      {editing && (
        <GameFormModal
          entry={editing}
          onClose={() => setEditing(null)}
          onSave={(params) => saveEntry(editing, params)}
          onRemove={editing.noteId ? () => removeEntry(editing) : null}
        />
      )}
      {adding && <AddGameModal date={date} onClose={() => setAdding(false)} onAdd={addManualGame} />}
    </div>
  );
}

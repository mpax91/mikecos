import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { HomePaint } from '../api/types';
import type { RoomOption } from './HomeNetworkDeviceModal';
import { HomePaintModal, paintColorLabel } from './HomePaintModal';

/** Brand + code + name, lower-cased — same key = same paint color. */
function colorKey(p: HomePaint): string | null {
  if (!p.colorCode && !p.colorName) return null;
  return [p.brand, p.colorCode, p.colorName].map((v) => (v ?? '').trim().toLowerCase()).join('|');
}

/** One painted surface laid out like a paint store's color sheet: surface on
 * the left; brand, type, finish, color and tint formula on the right. */
export function PaintEntry({ p, onClick }: { p: HomePaint; onClick?: () => void }) {
  const color = paintColorLabel(p);
  const painted = p.paintedOn ? new Date(`${p.paintedOn}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
  return (
    <button type="button" className="home-paint-entry" onClick={onClick}>
      <span className="home-paint-entry__surface">{p.surface}</span>
      <span className="home-paint-entry__body">
        {(color || p.hex) && (
          <span className="home-paint-entry__color">
            <span className="home-paint-swatch" style={p.hex ? { background: p.hex } : undefined} data-empty={p.hex ? undefined : ''} aria-hidden />
            {color || p.hex}
          </span>
        )}
        {(p.brand || p.product || p.finish) && <span className="home-paint-entry__line">{[p.brand, p.product, p.finish].filter(Boolean).join(' · ')}</span>}
        {p.formula && <span className="home-paint-entry__formula home-net-mono">{p.formula}</span>}
        {(painted || p.store) && <span className="home-paint-entry__meta">{[painted && `Painted ${painted}`, p.store].filter(Boolean).join(' · ')}</span>}
        {p.notes && <span className="home-paint-entry__meta">{p.notes}</span>}
      </span>
    </button>
  );
}

/** Home → 🎨 Paint: every room's paint colors, grouped by floor, plus a
 * "Colors in Use" strip (tap one to see where it's used). Rooms with nothing
 * recorded yet are listed per floor so each one has a place to add paint. */
export function HomePaintPage({ rooms }: { rooms: RoomOption[] }) {
  const [paints, setPaints] = useState<HomePaint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [colorFilter, setColorFilter] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ paint: HomePaint | 'new'; roomId?: string } | null>(null);

  const load = useCallback(() => {
    api
      .listHomePaints()
      .then(setPaints)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const colors = useMemo(() => {
    const m = new Map<string, { key: string; sample: HomePaint; rooms: Set<string> }>();
    for (const p of paints ?? []) {
      const k = colorKey(p);
      if (!k) continue;
      let c = m.get(k);
      if (!c) m.set(k, (c = { key: k, sample: p, rooms: new Set() }));
      c.rooms.add(p.roomId ?? '~');
      if (!c.sample.hex && p.hex) c.sample = p;
    }
    return [...m.values()].sort((a, b) => b.rooms.size - a.rooms.size || paintColorLabel(a.sample).localeCompare(paintColorLabel(b.sample)));
  }, [paints]);

  if (error) return <div className="empty-state">Couldn't load paint: {error}</div>;
  if (!paints) return <div className="empty-state">Loading…</div>;

  const q = query.trim().toLowerCase();
  const matches = (p: HomePaint) =>
    (!colorFilter || colorKey(p) === colorFilter) &&
    (!q || [p.surface, p.brand, p.product, p.finish, p.colorName, p.colorCode, p.formula, p.store, p.notes, p.roomName].some((v) => v?.toLowerCase().includes(q)));
  const filtering = !!q || !!colorFilter;

  const byRoom = new Map<string, HomePaint[]>();
  for (const p of paints) {
    if (!matches(p)) continue;
    const k = p.roomId ?? '~';
    byRoom.set(k, [...(byRoom.get(k) ?? []), p]);
  }

  const floors: { id: string; name: string; rooms: RoomOption[] }[] = [];
  for (const r of rooms) {
    let f = floors.find((x) => x.id === r.floorId);
    if (!f) floors.push((f = { id: r.floorId, name: r.floorName, rooms: [] }));
    f.rooms.push(r);
  }
  const roomsWithPaint = new Set(paints.map((p) => p.roomId).filter(Boolean));
  const unassigned = byRoom.get('~') ?? [];

  function onSaved(saved: HomePaint) {
    setPaints((prev) => {
      const list = prev ?? [];
      return list.some((x) => x.id === saved.id) ? list.map((x) => (x.id === saved.id ? saved : x)) : [...list, saved];
    });
    setEditing(null);
  }

  function roomCard(r: RoomOption, list: HomePaint[]) {
    return (
      <div key={r.id} className="home-paint-room">
        <div className="home-paint-room__head">
          <span className="home-paint-room__name">{r.name}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing({ paint: 'new', roomId: r.id })}>
            + Add
          </button>
        </div>
        {list.map((p) => (
          <PaintEntry key={p.id} p={p} onClick={() => setEditing({ paint: p })} />
        ))}
      </div>
    );
  }

  return (
    <div className="home-net home-paint">
      <div className="home-net__toolbar">
        <input className="home-net__search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search color, brand, code, room…" aria-label="Search paint" />
        <div className="home-net__actions">
          <button className="btn" onClick={() => setEditing({ paint: 'new' })}>
            + Add Paint
          </button>
        </div>
      </div>

      {colors.length > 0 && (
        <div className="home-net__summary">
          <span className="home-net__total">Colors in Use</span>
          {colors.map((c) => (
            <button key={c.key} type="button" className={`home-net__chip${colorFilter === c.key ? ' is-active' : ''}`} onClick={() => setColorFilter((prev) => (prev === c.key ? null : c.key))}>
              <span className="home-paint-swatch home-paint-swatch--sm" style={c.sample.hex ? { background: c.sample.hex } : undefined} data-empty={c.sample.hex ? undefined : ''} aria-hidden />
              {paintColorLabel(c.sample)} <b>{c.rooms.size}</b>
            </button>
          ))}
        </div>
      )}

      {paints.length === 0 && <div className="empty-state empty-state--section">No paint recorded yet. Tap a room's + Add below and type in what's on the can or the store's color sheet.</div>}

      {floors.map((f) => {
        const painted = f.rooms.filter((r) => byRoom.has(r.id));
        const notYet = f.rooms.filter((r) => !roomsWithPaint.has(r.id));
        if (filtering && painted.length === 0) return null;
        return (
          <section key={f.id} className="home-net__section">
            <h3 className="home-net__section-title">
              {f.name} <span>{f.rooms.length} Rooms</span>
            </h3>
            {painted.length > 0 && <div className="home-paint__grid">{painted.map((r) => roomCard(r, byRoom.get(r.id)!))}</div>}
            {!filtering && notYet.length > 0 && (
              <div className="home-paint__todo">
                <span className="home-net__muted">No paint yet:</span>
                {notYet.map((r) => (
                  <button key={r.id} type="button" className="home-paint__todo-room" onClick={() => setEditing({ paint: 'new', roomId: r.id })} title={`Add paint for ${r.name}`}>
                    + {r.name}
                  </button>
                ))}
              </div>
            )}
          </section>
        );
      })}

      {unassigned.length > 0 && (
        <section className="home-net__section">
          <h3 className="home-net__section-title">
            No Room <span>{unassigned.length}</span>
          </h3>
          <div className="home-paint__grid">
            <div className="home-paint-room">
              {unassigned.map((p) => (
                <PaintEntry key={p.id} p={p} onClick={() => setEditing({ paint: p })} />
              ))}
            </div>
          </div>
        </section>
      )}

      {filtering && byRoom.size === 0 && <div className="empty-state empty-state--section">Nothing matches.</div>}

      {editing && (
        <HomePaintModal
          paint={editing.paint}
          defaults={{ roomId: editing.roomId }}
          rooms={rooms}
          allPaints={paints}
          onSaved={onSaved}
          onDeleted={(id) => {
            setPaints((prev) => (prev ?? []).filter((x) => x.id !== id));
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

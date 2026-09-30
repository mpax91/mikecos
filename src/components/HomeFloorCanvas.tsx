import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { HomeFixture, HomeFixtureType, HomeRoom } from '../api/types';
import { formatFeetInches } from '../lib/homeUnits';
import { ConfirmModal } from './ConfirmModal';
import { HomeRoomModal, type HomeRoomFormValue } from './HomeRoomModal';
import { HomeFixtureModal, type HomeFixtureFormValue, FIXTURE_TYPE_LABEL } from './HomeFixtureModal';
import { KebabMenu } from './KebabMenu';

const MIN_SCALE = 0.5;
const MAX_SCALE = 15;
const DEFAULT_SCALE = 3; // CSS pixels per inch
const ROOM_GAP_IN = 24; // gap between auto-placed new rooms, in inches
const CLICK_THRESHOLD_PX = 4; // pointer movement under this = a click, not a drag

const FIXTURE_TYPES: HomeFixtureType[] = ['appliance', 'furniture', 'outlet', 'switch', 'fixture'];
const FIXTURE_ICON: Record<HomeFixtureType, string> = { appliance: '🔌', furniture: '🪑', outlet: '⏚', switch: '💡', fixture: '✦' };

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

interface Pan {
  x: number;
  y: number;
}

/** The to-scale floor canvas for one floor — rooms drawn as rectangles
 * sized to their real width/depth (in inches, at `scale` CSS px per inch),
 * with fixtures (appliance/furniture/outlet/switch/fixture) positioned
 * inside them. Pan/zoom/drag interaction mirrors CanvasBoardPage's proven
 * engine (see that file's header comments) — same math, reinterpreted so
 * "world coordinates" are inches instead of arbitrary board pixels, which
 * is what makes the map literally to-scale rather than just a diagram. */
export function HomeFloorCanvas({ floorId }: { floorId: string }) {
  const [rooms, setRooms] = useState<HomeRoom[] | null>(null);
  const [fixtures, setFixtures] = useState<HomeFixture[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<{ pan: Pan; scale: number }>({ pan: { x: 40, y: 40 }, scale: DEFAULT_SCALE });
  const { pan, scale } = view;

  const [roomModal, setRoomModal] = useState<'new' | HomeRoom | null>(null);
  const [deletingRoom, setDeletingRoom] = useState<HomeRoom | null>(null);
  const [fixtureModal, setFixtureModal] = useState<{ type: HomeFixtureType; roomId: string; initial?: HomeFixture } | null>(null);
  const [deletingFixture, setDeletingFixture] = useState<HomeFixture | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<
    | { kind: 'pan'; startX: number; startY: number; startPan: Pan; moved: number }
    | { kind: 'room-drag'; roomId: string; startX: number; startY: number; startRoomX: number; startRoomY: number; moved: number }
    | { kind: 'room-resize'; roomId: string; startX: number; startY: number; startWidth: number; startDepth: number }
    | { kind: 'fixture-drag'; fixtureId: string; startX: number; startY: number; startFixtureX: number; startFixtureY: number; moved: number }
    | null
  >(null);

  const load = useCallback(() => {
    api
      .getHomeFloorLayout(floorId)
      .then((res) => {
        setRooms(res.rooms);
        setFixtures(res.fixtures);
      })
      .catch((e) => setError(String(e)));
  }, [floorId]);

  useEffect(() => {
    load();
    setView({ pan: { x: 40, y: 40 }, scale: DEFAULT_SCALE });
  }, [load]);

  // Native wheel listener (not React's onWheel) so preventDefault reliably
  // stops the page itself from scrolling — see CanvasBoardPage.tsx for the
  // identical reasoning. Plain scroll pans; Ctrl/Cmd+scroll (also what a
  // trackpad pinch reports as) zooms, staying centered on the cursor.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = el!.getBoundingClientRect();
        const cursorX = e.clientX - rect.left;
        const cursorY = e.clientY - rect.top;
        setView(({ pan: prevPan, scale: prevScale }) => {
          const worldX = (cursorX - prevPan.x) / prevScale;
          const worldY = (cursorY - prevPan.y) / prevScale;
          const nextScale = clamp(prevScale * Math.exp(-e.deltaY * 0.001), MIN_SCALE, MAX_SCALE);
          return { scale: nextScale, pan: { x: cursorX - worldX * nextScale, y: cursorY - worldY * nextScale } };
        });
        return;
      }
      const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
      const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
      setView((prev) => ({ ...prev, pan: { x: prev.pan.x - dx, y: prev.pan.y - dy } }));
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [rooms]);

  function handleBackgroundPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.button === 1) e.preventDefault();
    gesture.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, startPan: pan, moved: 0 };
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function handleRoomPointerDown(room: HomeRoom, e: React.PointerEvent) {
    if (e.button !== 0) return;
    if ((e.target as Element).closest('.kebab-menu, .home-room__resize-handle')) return;
    e.stopPropagation();
    gesture.current = { kind: 'room-drag', roomId: room.id, startX: e.clientX, startY: e.clientY, startRoomX: room.x, startRoomY: room.y, moved: 0 };
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function handleRoomResizeStart(room: HomeRoom, e: React.PointerEvent) {
    e.stopPropagation();
    gesture.current = { kind: 'room-resize', roomId: room.id, startX: e.clientX, startY: e.clientY, startWidth: room.width, startDepth: room.depth };
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function handleFixturePointerDown(fixture: HomeFixture, e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    gesture.current = { kind: 'fixture-drag', fixtureId: fixture.id, startX: e.clientX, startY: e.clientY, startFixtureX: fixture.x, startFixtureY: fixture.y, moved: 0 };
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent) {
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pan') {
      g.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
      setView((prev) => ({ ...prev, pan: { x: g.startPan.x + (e.clientX - g.startX), y: g.startPan.y + (e.clientY - g.startY) } }));
    } else if (g.kind === 'room-drag') {
      g.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
      const dx = (e.clientX - g.startX) / scale;
      const dy = (e.clientY - g.startY) / scale;
      const x = Math.max(0, Math.round(g.startRoomX + dx));
      const y = Math.max(0, Math.round(g.startRoomY + dy));
      setRooms((prev) => (prev ? prev.map((r) => (r.id === g.roomId ? { ...r, x, y } : r)) : prev));
    } else if (g.kind === 'room-resize') {
      const dx = (e.clientX - g.startX) / scale;
      const dy = (e.clientY - g.startY) / scale;
      const width = Math.max(12, Math.round(g.startWidth + dx));
      const depth = Math.max(12, Math.round(g.startDepth + dy));
      setRooms((prev) => (prev ? prev.map((r) => (r.id === g.roomId ? { ...r, width, depth } : r)) : prev));
    } else if (g.kind === 'fixture-drag') {
      g.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
      const dx = (e.clientX - g.startX) / scale;
      const dy = (e.clientY - g.startY) / scale;
      const x = Math.max(0, Math.round(g.startFixtureX + dx));
      const y = Math.max(0, Math.round(g.startFixtureY + dy));
      setFixtures((prev) => (prev ? prev.map((f) => (f.id === g.fixtureId ? { ...f, x, y } : f)) : prev));
    }
  }

  function handlePointerUp() {
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.kind === 'pan') return;
    if (g.kind === 'room-drag') {
      const room = rooms?.find((r) => r.id === g.roomId);
      if (!room) return;
      if (g.moved < CLICK_THRESHOLD_PX) {
        setRoomModal(room);
        return;
      }
      api.updateHomeRoom(room.id, { x: room.x, y: room.y }).catch(() => load());
    } else if (g.kind === 'room-resize') {
      const room = rooms?.find((r) => r.id === g.roomId);
      if (!room) return;
      api.updateHomeRoom(room.id, { width: room.width, depth: room.depth }).catch(() => load());
    } else if (g.kind === 'fixture-drag') {
      const fixture = fixtures?.find((f) => f.id === g.fixtureId);
      if (!fixture) return;
      if (g.moved < CLICK_THRESHOLD_PX) {
        setFixtureModal({ type: fixture.type, roomId: fixture.roomId, initial: fixture });
        return;
      }
      api.updateHomeFixture(fixture.id, { x: fixture.x, y: fixture.y }).catch(() => load());
    }
  }

  function openAddRoom() {
    setRoomModal('new');
  }

  async function saveRoom(value: HomeRoomFormValue) {
    if (roomModal === 'new') {
      const x = rooms && rooms.length ? Math.max(...rooms.map((r) => r.x + r.width)) + ROOM_GAP_IN : 0;
      const created = await api.createHomeRoom(floorId, { ...value, x, y: 0 });
      setRooms((prev) => (prev ? [...prev, created] : [created]));
    } else if (roomModal) {
      const updated = await api.updateHomeRoom(roomModal.id, value);
      setRooms((prev) => (prev ? prev.map((r) => (r.id === updated.id ? updated : r)) : prev));
    }
    setRoomModal(null);
  }

  async function confirmDeleteRoom() {
    if (!deletingRoom) return;
    setRooms((prev) => (prev ? prev.filter((r) => r.id !== deletingRoom.id) : prev));
    setFixtures((prev) => (prev ? prev.filter((f) => f.roomId !== deletingRoom.id) : prev));
    await api.deleteHomeRoom(deletingRoom.id);
    setDeletingRoom(null);
    setRoomModal(null);
  }

  function openAddFixture(room: HomeRoom, type: HomeFixtureType) {
    setFixtureModal({ type, roomId: room.id });
  }

  async function saveFixture(value: HomeFixtureFormValue) {
    if (!fixtureModal) return;
    if (fixtureModal.initial) {
      const updated = await api.updateHomeFixture(fixtureModal.initial.id, value);
      setFixtures((prev) => (prev ? prev.map((f) => (f.id === updated.id ? updated : f)) : prev));
    } else {
      const room = rooms?.find((r) => r.id === fixtureModal.roomId);
      const count = fixtures?.filter((f) => f.roomId === fixtureModal.roomId).length ?? 0;
      const stagger = (count * 12) % Math.max(12, (room?.width ?? 60) - 24);
      const created = await api.createHomeFixture(fixtureModal.roomId, { type: fixtureModal.type, ...value, x: 12 + stagger, y: 12 });
      setFixtures((prev) => (prev ? [...prev, created] : [created]));
    }
    setFixtureModal(null);
  }

  async function confirmDeleteFixture() {
    if (!deletingFixture) return;
    setFixtures((prev) => (prev ? prev.filter((f) => f.id !== deletingFixture.id) : prev));
    await api.deleteHomeFixture(deletingFixture.id);
    setDeletingFixture(null);
    setFixtureModal(null);
  }

  function resetView() {
    setView({ pan: { x: 40, y: 40 }, scale: DEFAULT_SCALE });
  }

  if (error) return <div className="empty-state">Couldn't load this floor: {error}</div>;
  if (!rooms || !fixtures) return <div className="empty-state">Loading…</div>;

  return (
    <div className="home-canvas">
      <div className="home-canvas__toolbar">
        <button type="button" className="btn btn--ghost btn--sm" onClick={openAddRoom}>
          + Add Room
        </button>
        <span className="home-canvas__hint">Scroll to pan · Ctrl/Cmd+scroll to zoom · click a room's ⋯ to add appliances, furniture, outlets, switches</span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={resetView} style={{ marginLeft: 'auto' }}>
          Reset View
        </button>
      </div>

      <div
        ref={viewportRef}
        className="home-canvas__viewport"
        onPointerDown={handleBackgroundPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <div className="home-canvas__world" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}>
          {rooms.length === 0 && (
            <div className="home-canvas__empty" style={{ transform: `scale(${1 / scale})`, transformOrigin: 'top left' }}>
              No rooms on this floor yet — Add Room to start mapping it out.
            </div>
          )}
          {rooms.map((room) => {
            const roomFixtures = fixtures.filter((f) => f.roomId === room.id);
            return (
              <div
                key={room.id}
                className="home-room"
                style={{ left: room.x, top: room.y, width: room.width, height: room.depth }}
                onPointerDown={(e) => handleRoomPointerDown(room, e)}
              >
                <div className="home-room__header" style={{ transform: `scale(${1 / scale})`, transformOrigin: 'top left' }}>
                  <span className="home-room__title">{room.name}</span>
                  <span className="home-room__dims">
                    {formatFeetInches(room.width)} × {formatFeetInches(room.depth)}
                  </span>
                  <KebabMenu
                    items={[
                      ...FIXTURE_TYPES.map((t) => ({ label: `+ ${FIXTURE_TYPE_LABEL[t]}`, onClick: () => openAddFixture(room, t) })),
                      { label: 'Edit Room', onClick: () => setRoomModal(room), separatorBefore: true },
                      { label: 'Delete Room', onClick: () => setDeletingRoom(room), danger: true },
                    ]}
                  />
                </div>
                {roomFixtures.map((fixture) => (
                  <div
                    key={fixture.id}
                    className={`home-fixture home-fixture--${fixture.type}`}
                    style={{ left: fixture.x, top: fixture.y, width: fixture.width, height: fixture.depth }}
                    onPointerDown={(e) => handleFixturePointerDown(fixture, e)}
                    title={fixture.label}
                  >
                    <span className="home-fixture__inner" style={{ transform: `scale(${1 / scale})` }}>
                      <span className="home-fixture__icon">{FIXTURE_ICON[fixture.type]}</span>
                      <span className="home-fixture__label">{fixture.label}</span>
                      {(fixture.vaultEntryId || fixture.breakerId) && (
                        <span className="home-fixture__badges">
                          {fixture.vaultEntryId && <span className="home-fixture__badge" title="Linked to a Vault entry">📄</span>}
                          {fixture.breakerId && <span className="home-fixture__badge" title={`Breaker #${fixture.breakerNumber}`}>⚡</span>}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
                <div className="home-room__resize-handle" onPointerDown={(e) => handleRoomResizeStart(room, e)} style={{ transform: `scale(${1 / scale})`, transformOrigin: 'bottom right' }} />
              </div>
            );
          })}
        </div>
      </div>

      {roomModal && (
        <HomeRoomModal
          initial={roomModal === 'new' ? undefined : roomModal}
          onSave={saveRoom}
          onDelete={roomModal !== 'new' ? () => setDeletingRoom(roomModal) : undefined}
          onClose={() => setRoomModal(null)}
        />
      )}

      {deletingRoom && (
        <ConfirmModal
          title="Delete this room?"
          body={`"${deletingRoom.name}" and every appliance, furniture, outlet, switch, and fixture placed in it will be permanently deleted. Any linked Vault entries are kept.`}
          onConfirm={confirmDeleteRoom}
          onCancel={() => setDeletingRoom(null)}
        />
      )}

      {fixtureModal && (
        <HomeFixtureModal
          type={fixtureModal.type}
          initial={fixtureModal.initial}
          onSave={saveFixture}
          onDelete={fixtureModal.initial ? () => setDeletingFixture(fixtureModal.initial!) : undefined}
          onClose={() => setFixtureModal(null)}
        />
      )}

      {deletingFixture && (
        <ConfirmModal
          title="Delete this fixture?"
          body={`"${deletingFixture.label}" will be permanently removed from the map. Any linked Vault entry is kept.`}
          onConfirm={confirmDeleteFixture}
          onCancel={() => setDeletingFixture(null)}
        />
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';
import type { HomeFloor, HomeFixture, HomeFixtureType, HomeRoom, HomeWallItem, HomeWallItemType } from '../api/types';
import { formatFeetInches } from '../lib/homeUnits';
import {
  type Point,
  boundingBox,
  normalizeShape,
  polygonToSvgPoints,
  wallSegment,
  pointAlongWall,
  offsetOnWall,
  inwardNormal,
  dragWall,
  insertNotch,
  relocateAfterShapeChange,
  canDragWall,
  canAddCorner,
} from '../lib/homeGeometry';
import { specFromRoom, type SolvedRoom } from '../lib/roomSpec';
import { HomeRoomSpecModal } from './HomeRoomSpecModal';
import { ConfirmModal } from './ConfirmModal';
import { HomeRoomModal, type HomeRoomFormValue } from './HomeRoomModal';
import { HomeFixtureModal, type HomeFixtureFormValue, FIXTURE_TYPE_LABEL } from './HomeFixtureModal';
import { HomeWallItemModal, type HomeWallItemFormValue } from './HomeWallItemModal';
import { KebabMenu } from './KebabMenu';

const MIN_SCALE = 0.5;
const MAX_SCALE = 15;
const DEFAULT_SCALE = 3; // CSS pixels per inch
const ROOM_GAP_IN = 24; // gap between auto-placed new rooms, in inches
const CLICK_THRESHOLD_PX = 4; // pointer movement under this = a click, not a drag
const DEFAULT_WALL_ITEM_WIDTH: Record<HomeWallItemType, number> = { door: 30, window: 36 };

const FIXTURE_TYPES: HomeFixtureType[] = ['appliance', 'furniture', 'outlet', 'switch', 'fixture'];
const FIXTURE_ICON: Record<HomeFixtureType, string> = { appliance: '🔌', furniture: '🪑', outlet: '⏚', switch: '💡', fixture: '✦' };

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

interface Pan {
  x: number;
  y: number;
}

/** A small "what do you want on this wall?" menu, opened by clicking
 * (not dragging) a wall — portaled to <body> and positioned at the
 * click's screen coordinates, styled the same as KebabMenu's dropdown
 * so it needs no CSS of its own. */
function WallMenu({ x, y, onAddDoor, onAddWindow, onAddCorner, onClose }: { x: number; y: number; onAddDoor: () => void; onAddWindow: () => void; onAddCorner?: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDocDown(e: MouseEvent) {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    }
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [onClose]);
  return createPortal(
    <div ref={ref} className="kebab-menu__dropdown card" style={{ position: 'fixed', top: y, left: x }} onClick={(e) => e.stopPropagation()}>
      <div className="kebab-menu__item" onClick={onAddDoor}>
        + Door
      </div>
      <div className="kebab-menu__item" onClick={onAddWindow}>
        + Window
      </div>
      {onAddCorner && (
        <div className="kebab-menu__item" onClick={onAddCorner}>
          + Add Corner
        </div>
      )}
    </div>,
    document.body
  );
}

/** The to-scale floor canvas for one floor — rooms drawn as rectilinear
 * polygons (an SVG overlay sized to their bounding box, in inches at
 * `scale` CSS px per inch — see src/lib/homeGeometry.ts), with doors and
 * windows mounted along their walls and fixtures positioned inside.
 * Pan/zoom/drag interaction mirrors CanvasBoardPage's proven engine (see
 * that file's header comments) — same math, reinterpreted so "world
 * coordinates" are inches instead of arbitrary board pixels, which is
 * what makes the map literally to-scale rather than just a diagram.
 *
 * Fixtures only ever deal with a room's bounding box (x/y relative to
 * room.x/room.y), never its polygon shape — a deliberate isolation so
 * reshaping a room into an L never touches fixture placement math.
 * Reshaping itself is wall-based: drag a wall perpendicular to itself to
 * move it (dragWall), or click a wall for a menu that can split it into
 * a new draggable notch (insertNotch). See homeGeometry.ts's header for
 * why this is wall-based rather than corner-based.
 *
 * Home is room-first: HomePage passes `roomId` and the canvas shows just
 * that one room (the floor's other rooms are loaded but not drawn). Add
 * Room / Import can target any floor (`floors` feeds the modals' Floor
 * picker); `onRoomsChanged` lets the page refresh its Rooms dropdown and
 * `onSelectRoom` jumps to a newly added or moved room. */
export function HomeFloorCanvas({
  floorId,
  roomId = null,
  floors,
  onRoomsChanged,
  onSelectRoom,
}: {
  floorId: string;
  roomId?: string | null;
  floors?: HomeFloor[];
  onRoomsChanged?: () => void;
  onSelectRoom?: (roomId: string) => void;
}) {
  const [rooms, setRooms] = useState<HomeRoom[] | null>(null);
  const [fixtures, setFixtures] = useState<HomeFixture[] | null>(null);
  const [wallItems, setWallItems] = useState<HomeWallItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What's drawn: the one focused room, or the whole floor.
  const shownRooms = useMemo(() => (rooms && roomId ? rooms.filter((r) => r.id === roomId) : rooms), [rooms, roomId]);

  const [view, setView] = useState<{ pan: Pan; scale: number }>({ pan: { x: 40, y: 40 }, scale: DEFAULT_SCALE });
  const { pan, scale } = view;

  const [roomModal, setRoomModal] = useState<'new' | HomeRoom | null>(null);
  const [deletingRoom, setDeletingRoom] = useState<HomeRoom | null>(null);
  const [fixtureModal, setFixtureModal] = useState<{ type: HomeFixtureType; roomId: string; initial?: HomeFixture } | null>(null);
  const [deletingFixture, setDeletingFixture] = useState<HomeFixture | null>(null);
  const [wallItemModal, setWallItemModal] = useState<{ type: HomeWallItemType; roomId: string; wallIndex: number; offset: number; initial?: HomeWallItem } | null>(null);
  const [deletingWallItem, setDeletingWallItem] = useState<HomeWallItem | null>(null);
  const [wallMenu, setWallMenu] = useState<{ roomId: string; wallIndex: number; offset: number; screenX: number; screenY: number } | null>(null);
  const [specModal, setSpecModal] = useState<'new' | HomeRoom | null>(null);
  const [copiedRoomId, setCopiedRoomId] = useState<string | null>(null);
  // Room name labels can be hidden (they then show only on hover, so the
  // room's ⋯ menu stays reachable). Remembered per browser.
  const [labelsHidden, setLabelsHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem('mikeos.home.labelsHidden') === '1';
    } catch {
      return false;
    }
  });
  function toggleLabels() {
    setLabelsHidden((prev) => {
      try {
        localStorage.setItem('mikeos.home.labelsHidden', prev ? '0' : '1');
      } catch {
        // storage unavailable — toggle still works for this visit
      }
      return !prev;
    });
  }

  const viewportRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<
    | { kind: 'pan'; startX: number; startY: number; startPan: Pan; moved: number }
    | { kind: 'room-drag'; roomId: string; startX: number; startY: number; startRoomX: number; startRoomY: number; moved: number }
    | { kind: 'fixture-drag'; fixtureId: string; startX: number; startY: number; startFixtureX: number; startFixtureY: number; moved: number }
    | { kind: 'wall-drag'; roomId: string; wallIndex: number; startX: number; startY: number; startPoints: Point[]; startRoomX: number; startRoomY: number; rawPoints: Point[]; moved: number }
    | { kind: 'wallitem-drag'; itemId: string; startX: number; startY: number; startOffset: number; wallIndex: number; roomId: string; moved: number }
    | null
  >(null);

  const load = useCallback(() => {
    api
      .getHomeFloorLayout(floorId)
      .then((res) => {
        setRooms(res.rooms);
        setFixtures(res.fixtures);
        setWallItems(res.wallItems);
      })
      .catch((e) => setError(String(e)));
  }, [floorId]);

  // Each floor opens zoomed to fit its rooms (once — reloads after an
  // edit don't yank the view around).
  const didInitialFit = useRef(false);
  useEffect(() => {
    load();
    didInitialFit.current = false;
    setView({ pan: { x: 40, y: 40 }, scale: DEFAULT_SCALE });
  }, [load]);

  /** Zoom so every room on the floor fits in the viewport, centered. */
  const fitToRooms = useCallback(() => {
    const el = viewportRef.current;
    const fit = shownRooms;
    if (!el || !fit || fit.length === 0) {
      setView({ pan: { x: 40, y: 40 }, scale: DEFAULT_SCALE });
      return;
    }
    const minX = Math.min(...fit.map((r) => r.x));
    const minY = Math.min(...fit.map((r) => r.y));
    const maxX = Math.max(...fit.map((r) => r.x + r.width));
    const maxY = Math.max(...fit.map((r) => r.y + r.depth));
    const { width: vw, height: vh } = el.getBoundingClientRect();
    const PAD_PX = 56; // room for labels above rooms + breathing room
    const next = clamp(Math.min((vw - PAD_PX * 2) / Math.max(1, maxX - minX), (vh - PAD_PX * 2) / Math.max(1, maxY - minY)), MIN_SCALE, MAX_SCALE);
    setView({
      scale: next,
      pan: { x: (vw - (maxX - minX) * next) / 2 - minX * next, y: (vh - (maxY - minY) * next) / 2 - minY * next + 12 },
    });
  }, [shownRooms]);

  useEffect(() => {
    if (didInitialFit.current || !shownRooms || !viewportRef.current) return;
    didInitialFit.current = true;
    if (shownRooms.length) fitToRooms();
  }, [shownRooms, fitToRooms]);

  /** Zoom by `factor`, keeping the viewport point (cx, cy) fixed — the
   * viewport's center when not given (the +/− buttons). */
  function zoomBy(factor: number, cx?: number, cy?: number) {
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = cx ?? rect.width / 2;
    const py = cy ?? rect.height / 2;
    setView(({ pan: prevPan, scale: prevScale }) => {
      const nextScale = clamp(prevScale * factor, MIN_SCALE, MAX_SCALE);
      const worldX = (px - prevPan.x) / prevScale;
      const worldY = (py - prevPan.y) / prevScale;
      return { scale: nextScale, pan: { x: px - worldX * nextScale, y: py - worldY * nextScale } };
    });
  }

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
    // Two-finger pinch on phones/tablets: zoom around the midpoint between
    // the fingers. Cancels any one-finger pan/drag the first touch started.
    let pinch: { dist: number } | null = null;
    function touchDist(t: TouchList) {
      return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    }
    function onTouchStart(e: TouchEvent) {
      if (e.touches.length === 2) {
        gesture.current = null;
        pinch = { dist: touchDist(e.touches) };
      }
    }
    function onTouchMove(e: TouchEvent) {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const d = touchDist(e.touches);
      const rect = el!.getBoundingClientRect();
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
      const my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
      const factor = d / pinch.dist;
      pinch.dist = d;
      setView(({ pan: prevPan, scale: prevScale }) => {
        const nextScale = clamp(prevScale * factor, MIN_SCALE, MAX_SCALE);
        const worldX = (mx - prevPan.x) / prevScale;
        const worldY = (my - prevPan.y) / prevScale;
        return { scale: nextScale, pan: { x: mx - worldX * nextScale, y: my - worldY * nextScale } };
      });
    }
    function onTouchEnd(e: TouchEvent) {
      if (e.touches.length < 2) pinch = null;
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [rooms]);

  /** Screen (clientX/Y) → floor-absolute inches, given the current pan/zoom. */
  function screenToWorld(clientX: number, clientY: number): Point {
    const rect = viewportRef.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - pan.x) / scale, y: (clientY - rect.top - pan.y) / scale };
  }

  function handleBackgroundPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.button === 1) e.preventDefault();
    gesture.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, startPan: pan, moved: 0 };
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function handleRoomPointerDown(room: HomeRoom, e: React.PointerEvent) {
    if (e.button !== 0) return;
    if ((e.target as Element).closest('.kebab-menu, .home-room__wall-hit, .home-wall-item')) return;
    e.stopPropagation();
    gesture.current = { kind: 'room-drag', roomId: room.id, startX: e.clientX, startY: e.clientY, startRoomX: room.x, startRoomY: room.y, moved: 0 };
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function handleWallPointerDown(room: HomeRoom, wallIndex: number, e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    gesture.current = { kind: 'wall-drag', roomId: room.id, wallIndex, startX: e.clientX, startY: e.clientY, startPoints: room.points, startRoomX: room.x, startRoomY: room.y, rawPoints: room.points, moved: 0 };
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function handleFixturePointerDown(fixture: HomeFixture, e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    gesture.current = { kind: 'fixture-drag', fixtureId: fixture.id, startX: e.clientX, startY: e.clientY, startFixtureX: fixture.x, startFixtureY: fixture.y, moved: 0 };
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function handleWallItemPointerDown(item: HomeWallItem, e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    gesture.current = { kind: 'wallitem-drag', itemId: item.id, startX: e.clientX, startY: e.clientY, startOffset: item.offset, wallIndex: item.wallIndex, roomId: item.roomId, moved: 0 };
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
    } else if (g.kind === 'wall-drag') {
      g.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
      // Angled bay walls / curve chords from an imported spec aren't
      // draggable (see canDragWall) — the gesture only counts as a click.
      if (!canDragWall(g.startPoints, g.wallIndex)) return;
      const dx = (e.clientX - g.startX) / scale;
      const dy = (e.clientY - g.startY) / scale;
      const { nx, ny } = inwardNormal(g.startPoints, g.wallIndex);
      const delta = dx * nx + dy * ny;
      const raw = dragWall(g.startPoints, g.wallIndex, delta);
      g.rawPoints = raw;
      const { points, dx: shiftX, dy: shiftY } = normalizeShape(raw);
      const bbox = boundingBox(points);
      const roomX = g.startRoomX + shiftX;
      const roomY = g.startRoomY + shiftY;
      setRooms((prev) => (prev ? prev.map((r) => (r.id === g.roomId ? { ...r, points, width: bbox.width, depth: bbox.depth, x: roomX, y: roomY } : r)) : prev));
      if (shiftX || shiftY) {
        setFixtures((prev) => (prev ? prev.map((f) => (f.roomId === g.roomId ? { ...f, x: f.x - shiftX, y: f.y - shiftY } : f)) : prev));
      }
    } else if (g.kind === 'fixture-drag') {
      g.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
      const dx = (e.clientX - g.startX) / scale;
      const dy = (e.clientY - g.startY) / scale;
      const x = Math.max(0, Math.round(g.startFixtureX + dx));
      const y = Math.max(0, Math.round(g.startFixtureY + dy));
      setFixtures((prev) => (prev ? prev.map((f) => (f.id === g.fixtureId ? { ...f, x, y } : f)) : prev));
    } else if (g.kind === 'wallitem-drag') {
      g.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
      const room = rooms?.find((r) => r.id === g.roomId);
      const item = wallItems?.find((w) => w.id === g.itemId);
      if (!room || !item) return;
      const { ux, uy, length } = wallSegment(room.points, g.wallIndex);
      const dx = (e.clientX - g.startX) / scale;
      const dy = (e.clientY - g.startY) / scale;
      const deltaAlong = dx * ux + dy * uy;
      const offset = clamp(Math.round(g.startOffset + deltaAlong), 0, Math.max(0, length - item.width));
      setWallItems((prev) => (prev ? prev.map((w) => (w.id === g.itemId ? { ...w, offset } : w)) : prev));
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
    } else if (g.kind === 'wall-drag') {
      const room = rooms?.find((r) => r.id === g.roomId);
      if (!room) return;
      if (g.moved < CLICK_THRESHOLD_PX) {
        const local = screenToWorld(g.startX, g.startY);
        const offset = offsetOnWall(g.startPoints, g.wallIndex, { x: local.x - g.startRoomX, y: local.y - g.startRoomY });
        setWallMenu({ roomId: g.roomId, wallIndex: g.wallIndex, offset, screenX: g.startX, screenY: g.startY });
        return;
      }
      if (!canDragWall(g.startPoints, g.wallIndex)) return;
      // Re-anchor any doors/windows on this room's walls to whichever edge
      // of the reshaped polygon now passes through where they actually
      // sit — see relocateAfterShapeChange's header for why this works
      // for both a wall drag (lengths change) and a notch (indices shift).
      const roomWallItems = (wallItems ?? []).filter((w) => w.roomId === g.roomId);
      for (const item of roomWallItems) {
        const { wallIndex, offset } = relocateAfterShapeChange(g.startPoints, g.rawPoints, item.wallIndex, item.offset);
        if (wallIndex !== item.wallIndex || offset !== item.offset) {
          setWallItems((prev) => (prev ? prev.map((w) => (w.id === item.id ? { ...w, wallIndex, offset } : w)) : prev));
          api.updateHomeWallItem(item.id, { wallIndex, offset }).catch(() => load());
        }
      }
      api.updateHomeRoom(room.id, { points: room.points, x: room.x, y: room.y }).catch(() => load());
    } else if (g.kind === 'fixture-drag') {
      const fixture = fixtures?.find((f) => f.id === g.fixtureId);
      if (!fixture) return;
      if (g.moved < CLICK_THRESHOLD_PX) {
        setFixtureModal({ type: fixture.type, roomId: fixture.roomId, initial: fixture });
        return;
      }
      api.updateHomeFixture(fixture.id, { x: fixture.x, y: fixture.y }).catch(() => load());
    } else if (g.kind === 'wallitem-drag') {
      const item = wallItems?.find((w) => w.id === g.itemId);
      if (!item) return;
      if (g.moved < CLICK_THRESHOLD_PX) {
        setWallItemModal({ type: item.type, roomId: item.roomId, wallIndex: item.wallIndex, offset: item.offset, initial: item });
        return;
      }
      api.updateHomeWallItem(item.id, { offset: item.offset }).catch(() => load());
    }
  }

  function openAddRoom() {
    setRoomModal('new');
  }

  async function saveRoom(value: HomeRoomFormValue) {
    const { floorId: targetFloorId, ...fields } = value;
    if (roomModal === 'new') {
      const target = targetFloorId ?? floorId;
      const x = target === floorId && rooms && rooms.length ? Math.max(...rooms.map((r) => r.x + r.width)) + ROOM_GAP_IN : 0;
      const created = await api.createHomeRoom(target, { ...fields, x, y: 0 });
      if (target === floorId) setRooms((prev) => (prev ? [...prev, created] : [created]));
      setRoomModal(null);
      onRoomsChanged?.();
      onSelectRoom?.(created.id);
      return;
    } else if (roomModal) {
      const moving = targetFloorId !== undefined && targetFloorId !== roomModal.floorId;
      const updated = await api.updateHomeRoom(roomModal.id, moving ? { ...fields, floorId: targetFloorId } : fields);
      setRooms((prev) => (prev ? (moving ? prev.filter((r) => r.id !== updated.id) : prev.map((r) => (r.id === updated.id ? updated : r))) : prev));
      setRoomModal(null);
      onRoomsChanged?.();
      if (moving) onSelectRoom?.(updated.id);
      return;
    }
    setRoomModal(null);
  }

  async function confirmDeleteRoom() {
    if (!deletingRoom) return;
    setRooms((prev) => (prev ? prev.filter((r) => r.id !== deletingRoom.id) : prev));
    setFixtures((prev) => (prev ? prev.filter((f) => f.roomId !== deletingRoom.id) : prev));
    setWallItems((prev) => (prev ? prev.filter((w) => w.roomId !== deletingRoom.id) : prev));
    await api.deleteHomeRoom(deletingRoom.id);
    setDeletingRoom(null);
    setRoomModal(null);
    onRoomsChanged?.();
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

  function openAddWallItem(type: HomeWallItemType) {
    if (!wallMenu) return;
    const room = rooms?.find((r) => r.id === wallMenu.roomId);
    if (!room) return;
    const { length } = wallSegment(room.points, wallMenu.wallIndex);
    const width = Math.min(DEFAULT_WALL_ITEM_WIDTH[type], Math.max(1, length));
    const offset = clamp(Math.round(wallMenu.offset - width / 2), 0, Math.max(0, length - width));
    setWallItemModal({ type, roomId: wallMenu.roomId, wallIndex: wallMenu.wallIndex, offset });
    setWallMenu(null);
  }

  function addCorner() {
    if (!wallMenu) return;
    const room = rooms?.find((r) => r.id === wallMenu.roomId);
    if (!room) return;
    const oldPoints = room.points;
    const newPointsRaw = insertNotch(oldPoints, wallMenu.wallIndex, wallMenu.offset);
    const { points, dx, dy } = normalizeShape(newPointsRaw);
    const bbox = boundingBox(points);
    const roomX = room.x + dx;
    const roomY = room.y + dy;
    setRooms((prev) => (prev ? prev.map((r) => (r.id === room.id ? { ...r, points, width: bbox.width, depth: bbox.depth, x: roomX, y: roomY } : r)) : prev));
    if (dx || dy) {
      setFixtures((prev) => (prev ? prev.map((f) => (f.roomId === room.id ? { ...f, x: f.x - dx, y: f.y - dy } : f)) : prev));
    }
    const roomWallItems = (wallItems ?? []).filter((w) => w.roomId === room.id);
    for (const item of roomWallItems) {
      const relocated = relocateAfterShapeChange(oldPoints, newPointsRaw, item.wallIndex, item.offset);
      if (relocated.wallIndex !== item.wallIndex || relocated.offset !== item.offset) {
        setWallItems((prev) => (prev ? prev.map((w) => (w.id === item.id ? { ...w, ...relocated } : w)) : prev));
        api.updateHomeWallItem(item.id, relocated).catch(() => load());
      }
    }
    api.updateHomeRoom(room.id, { points, x: roomX, y: roomY }).catch(() => load());
    setWallMenu(null);
  }

  async function saveWallItem(value: HomeWallItemFormValue) {
    if (!wallItemModal) return;
    if (wallItemModal.initial) {
      const updated = await api.updateHomeWallItem(wallItemModal.initial.id, value);
      setWallItems((prev) => (prev ? prev.map((w) => (w.id === updated.id ? updated : w)) : prev));
    } else {
      const created = await api.createHomeWallItem(wallItemModal.roomId, { type: wallItemModal.type, wallIndex: wallItemModal.wallIndex, offset: wallItemModal.offset, ...value });
      setWallItems((prev) => (prev ? [...prev, created] : [created]));
    }
    setWallItemModal(null);
  }

  async function confirmDeleteWallItem() {
    if (!deletingWallItem) return;
    setWallItems((prev) => (prev ? prev.filter((w) => w.id !== deletingWallItem.id) : prev));
    await api.deleteHomeWallItem(deletingWallItem.id);
    setDeletingWallItem(null);
    setWallItemModal(null);
  }

  /** New room from a spec — auto-placed to the right of everything else on
   * the floor, same as Add Room. */
  async function importRoomFromSpec(solved: SolvedRoom, name: string, targetFloorId?: string) {
    const payload = { points: solved.points, ceilingHeight: solved.ceilingHeight, spec: solved.spec, wallItems: solved.wallItems };
    if (specModal && specModal !== 'new') {
      await api.reshapeHomeRoom(specModal.id, payload);
      setSpecModal(null);
      load();
      return;
    }
    const target = targetFloorId ?? floorId;
    const x = target === floorId && rooms && rooms.length ? Math.max(...rooms.map((r) => r.x + r.width)) + ROOM_GAP_IN : 0;
    const created = await api.importHomeRoom(target, { ...payload, name, x, y: 0, notes: solved.notes });
    setSpecModal(null);
    load();
    onRoomsChanged?.();
    onSelectRoom?.(created.id);
  }

  function copyRoomSpec(room: HomeRoom) {
    const spec = specFromRoom(room, (wallItems ?? []).filter((w) => w.roomId === room.id));
    navigator.clipboard.writeText(JSON.stringify(spec, null, 2)).then(() => {
      setCopiedRoomId(room.id);
      window.setTimeout(() => setCopiedRoomId((prev) => (prev === room.id ? null : prev)), 1800);
    });
  }

  if (error) return <div className="empty-state">Couldn't load this floor: {error}</div>;
  if (!rooms || !shownRooms || !fixtures || !wallItems) return <div className="empty-state">Loading…</div>;

  return (
    <div className={`home-canvas${labelsHidden ? ' home-canvas--labels-hidden' : ''}`}>
      <div className="home-canvas__toolbar">
        <button type="button" className="btn btn--ghost btn--sm" onClick={openAddRoom}>
          + Add Room
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSpecModal('new')}>
          Import Room Spec
        </button>
        <span className="home-canvas__hint">
          Scroll to pan · Ctrl/Cmd+scroll or pinch to zoom · drag a wall to reshape · click a wall for doors/windows/corners · click a room's ⋯ for appliances, furniture, outlets, switches
        </span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={toggleLabels} style={{ marginLeft: 'auto' }}>
          {labelsHidden ? 'Show Labels' : 'Hide Labels'}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={fitToRooms}>
          {roomId ? 'Fit to Room' : 'Fit to Rooms'}
        </button>
      </div>

      <div
        ref={viewportRef}
        className="home-canvas__viewport"
        onPointerDown={handleBackgroundPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <div className="home-canvas__zoom" onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" onClick={() => zoomBy(1 / 1.25)} aria-label="Zoom out" title="Zoom out">
            −
          </button>
          <button type="button" className="home-canvas__zoom-level" onClick={fitToRooms} title="Fit to rooms">
            {Math.round((scale / DEFAULT_SCALE) * 100)}%
          </button>
          <button type="button" onClick={() => zoomBy(1.25)} aria-label="Zoom in" title="Zoom in">
            +
          </button>
        </div>
        <div className="home-canvas__world" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}>
          {shownRooms.length === 0 && (
            <div className="home-canvas__empty" style={{ transform: `scale(${1 / scale})`, transformOrigin: 'top left' }}>
              No rooms on this floor yet — Add Room to start mapping it out.
            </div>
          )}
          {shownRooms.map((room) => {
            const roomFixtures = fixtures.filter((f) => f.roomId === room.id);
            const roomWallItems = wallItems.filter((w) => w.roomId === room.id);
            return (
              <div
                key={room.id}
                className="home-room"
                style={{ left: room.x, top: room.y, width: room.width, height: room.depth }}
                onPointerDown={(e) => handleRoomPointerDown(room, e)}
              >
                <svg className="home-room__svg" width={room.width} height={room.depth} viewBox={`0 0 ${room.width} ${room.depth}`}>
                  <polygon points={polygonToSvgPoints(room.points)} className="home-room__fill" />
                  {room.points.map((_, i) => {
                    const seg = wallSegment(room.points, i);
                    return (
                      <g key={i}>
                        <line x1={seg.a.x} y1={seg.a.y} x2={seg.b.x} y2={seg.b.y} className="home-room__wall" />
                        <line
                          x1={seg.a.x}
                          y1={seg.a.y}
                          x2={seg.b.x}
                          y2={seg.b.y}
                          className="home-room__wall-hit"
                          style={{ cursor: canDragWall(room.points, i) ? (seg.horizontal ? 'ns-resize' : 'ew-resize') : 'pointer' }}
                          onPointerDown={(e) => handleWallPointerDown(room, i, e)}
                        />
                      </g>
                    );
                  })}
                  {roomWallItems.map((item) => {
                    const start = pointAlongWall(room.points, item.wallIndex, item.offset);
                    const end = pointAlongWall(room.points, item.wallIndex, item.offset + item.width);
                    const { horizontal, axisAligned, ux, uy } = wallSegment(room.points, item.wallIndex);
                    const { nx, ny } = inwardNormal(room.points, item.wallIndex);
                    const gapPad = 3;
                    const gx1 = start.x - ux * gapPad;
                    const gy1 = start.y - uy * gapPad;
                    const gx2 = end.x + ux * gapPad;
                    const gy2 = end.y + uy * gapPad;
                    return (
                      <g key={item.id}>
                        <line x1={gx1} y1={gy1} x2={gx2} y2={gy2} className="home-wall-item__gap" />
                        {item.type === 'door' ? (
                          (() => {
                            const hinge = item.swing === 'right' ? end : start;
                            const latch = item.swing === 'right' ? start : end;
                            const openPoint = { x: hinge.x + nx * item.width, y: hinge.y + ny * item.width };
                            // Sweep direction from the geometry itself (closed latch
                            // -> open leaf around the hinge), so the arc is right on
                            // walls at any angle and either polygon winding.
                            const cross = (latch.x - hinge.x) * (openPoint.y - hinge.y) - (latch.y - hinge.y) * (openPoint.x - hinge.x);
                            return (
                              <>
                                <line x1={hinge.x} y1={hinge.y} x2={openPoint.x} y2={openPoint.y} className="home-wall-item__leaf" />
                                <path d={`M ${latch.x} ${latch.y} A ${item.width} ${item.width} 0 0 ${cross > 0 ? 1 : 0} ${openPoint.x} ${openPoint.y}`} className="home-wall-item__arc" />
                              </>
                            );
                          })()
                        ) : (
                          <>
                            <line x1={start.x + nx * 2.5} y1={start.y + ny * 2.5} x2={end.x + nx * 2.5} y2={end.y + ny * 2.5} className="home-wall-item__window-line" />
                            <line x1={start.x - nx * 2.5} y1={start.y - ny * 2.5} x2={end.x - nx * 2.5} y2={end.y - ny * 2.5} className="home-wall-item__window-line" />
                          </>
                        )}
                        <line
                          x1={start.x}
                          y1={start.y}
                          x2={end.x}
                          y2={end.y}
                          className="home-wall-item__hit"
                          style={{ cursor: axisAligned ? (horizontal ? 'ew-resize' : 'ns-resize') : 'grab' }}
                          onPointerDown={(e) => handleWallItemPointerDown(item, e)}
                        />
                      </g>
                    );
                  })}
                </svg>
                <div className="home-room__header" style={{ transform: `scale(${1 / scale})`, transformOrigin: 'bottom left' }}>
                  <span className="home-room__title">{room.name}</span>
                  <span className="home-room__dims">
                    {formatFeetInches(room.width)} × {formatFeetInches(room.depth)}
                    {room.ceilingHeight ? ` · ${formatFeetInches(room.ceilingHeight)} ceiling` : ''}
                  </span>
                  <KebabMenu
                    items={[
                      ...FIXTURE_TYPES.map((t) => ({ label: `+ ${FIXTURE_TYPE_LABEL[t]}`, onClick: () => openAddFixture(room, t) })),
                      { label: 'Edit Room', onClick: () => setRoomModal(room), separatorBefore: true },
                      { label: 'Replace Shape from Spec…', onClick: () => setSpecModal(room) },
                      { label: copiedRoomId === room.id ? 'Room Spec Copied' : 'Copy Room Spec', onClick: () => copyRoomSpec(room) },
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
              </div>
            );
          })}
        </div>
      </div>

      {wallMenu && (
        <WallMenu
          x={wallMenu.screenX}
          y={wallMenu.screenY}
          onAddDoor={() => openAddWallItem('door')}
          onAddWindow={() => openAddWallItem('window')}
          onAddCorner={(() => {
            const r = rooms.find((rm) => rm.id === wallMenu.roomId);
            return r && canAddCorner(r.points, wallMenu.wallIndex) ? addCorner : undefined;
          })()}
          onClose={() => setWallMenu(null)}
        />
      )}

      {specModal && (
        <HomeRoomSpecModal
          room={specModal === 'new' ? undefined : specModal}
          initialText={specModal === 'new' ? undefined : JSON.stringify(specFromRoom(specModal, wallItems.filter((w) => w.roomId === specModal.id)), null, 2)}
          floors={floors}
          defaultFloorId={floorId}
          onImport={importRoomFromSpec}
          onClose={() => setSpecModal(null)}
        />
      )}

      {roomModal && (
        <HomeRoomModal
          initial={roomModal === 'new' ? undefined : roomModal}
          floors={floors}
          defaultFloorId={floorId}
          onSave={saveRoom}
          onDelete={roomModal !== 'new' ? () => setDeletingRoom(roomModal) : undefined}
          onClose={() => setRoomModal(null)}
        />
      )}

      {deletingRoom && (
        <ConfirmModal
          title="Delete this room?"
          body={`"${deletingRoom.name}" and every appliance, furniture, outlet, switch, fixture, door, and window placed in it will be permanently deleted. Any linked Vault entries are kept.`}
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

      {wallItemModal && (
        <HomeWallItemModal
          type={wallItemModal.type}
          initial={wallItemModal.initial}
          onSave={saveWallItem}
          onDelete={wallItemModal.initial ? () => setDeletingWallItem(wallItemModal.initial!) : undefined}
          onClose={() => setWallItemModal(null)}
        />
      )}

      {deletingWallItem && (
        <ConfirmModal
          title={`Delete this ${deletingWallItem.type}?`}
          body={`"${deletingWallItem.label}" will be permanently removed from the map. Any linked Vault entry is kept.`}
          onConfirm={confirmDeleteWallItem}
          onCancel={() => setDeletingWallItem(null)}
        />
      )}
    </div>
  );
}

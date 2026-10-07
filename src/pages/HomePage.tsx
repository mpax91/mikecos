import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { HomeFloor, HomeRoom } from '../api/types';
import { ConfirmModal } from '../components/ConfirmModal';
import { HomeElectricalPage } from '../components/HomeElectricalPage';
import { HomeFloorCanvas } from '../components/HomeFloorCanvas';
import { KebabMenu } from '../components/KebabMenu';
import { Modal } from '../components/Modal';
import { useReportTabMeta } from '../contexts/TabsContext';

/** What the page is showing: one room, an empty floor (so Add Room has
 * somewhere to land), or the Electrical pill. Other non-room pills slot in
 * here as their own literal. */
type Selection = `room:${string}` | `floor:${string}` | 'electrical';

const SELECTION_KEY = 'mikeos.home.selection';

function readStoredSelection(): Selection | null {
  try {
    return (localStorage.getItem(SELECTION_KEY) as Selection | null) ?? null;
  } catch {
    return null;
  }
}

function storeSelection(sel: Selection) {
  try {
    localStorage.setItem(SELECTION_KEY, sel);
  } catch {
    // storage unavailable — selection just isn't remembered
  }
}

/** Home — room-first. A Rooms dropdown (grouped by floor) picks one room,
 * shown alone on the to-scale canvas (HomeFloorCanvas with `roomId`);
 * Electrical (and any future non-room section) sits beside it as a pill.
 * Floors still exist in the data model (worker/migrations/0077_home.sql)
 * but only as the dropdown's groups — there's no whole-floor plan view. */
export function HomePage() {
  const [floors, setFloors] = useState<HomeFloor[] | null>(null);
  const [roomsByFloor, setRoomsByFloor] = useState<Record<string, HomeRoom[]>>({});
  const [selection, setSelectionState] = useState<Selection>(() => readStoredSelection() ?? 'electrical');
  const [error, setError] = useState<string | null>(null);

  const [floorModal, setFloorModal] = useState<'new' | HomeFloor | null>(null);
  const [floorName, setFloorName] = useState('');
  const [deletingFloor, setDeletingFloor] = useState<HomeFloor | null>(null);

  useReportTabMeta('Home', 'home-list');

  const setSelection = useCallback((sel: Selection) => {
    setSelectionState(sel);
    storeSelection(sel);
  }, []);

  /** Reload floors + every floor's rooms, then make sure the selection
   * still points at something that exists (first room, else first floor,
   * else Electrical). */
  const reload = useCallback(() => {
    api
      .listHomeFloors()
      .then(async (list) => {
        const layouts = await Promise.all(list.map((f) => api.getHomeFloorLayout(f.id)));
        const byFloor: Record<string, HomeRoom[]> = {};
        list.forEach((f, i) => {
          byFloor[f.id] = [...layouts[i].rooms].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        });
        setFloors(list);
        setRoomsByFloor(byFloor);
        setSelectionState((prev) => {
          const allRooms = list.flatMap((f) => byFloor[f.id]);
          const valid =
            prev === 'electrical' ||
            (prev.startsWith('room:') && allRooms.some((r) => `room:${r.id}` === prev)) ||
            (prev.startsWith('floor:') && list.some((f) => `floor:${f.id}` === prev && byFloor[f.id].length === 0));
          if (valid) return prev;
          const next: Selection = allRooms[0] ? `room:${allRooms[0].id}` : list[0] ? `floor:${list[0].id}` : 'electrical';
          storeSelection(next);
          return next;
        });
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  function openAddFloor() {
    setFloorName('');
    setFloorModal('new');
  }

  function openEditFloor(f: HomeFloor) {
    setFloorName(f.name);
    setFloorModal(f);
  }

  async function saveFloor() {
    if (!floorName.trim()) return;
    if (floorModal === 'new') {
      const created = await api.createHomeFloor(floorName.trim());
      setFloors((prev) => (prev ? [...prev, created] : [created]));
      setRoomsByFloor((prev) => ({ ...prev, [created.id]: [] }));
      setSelection(`floor:${created.id}`);
    } else if (floorModal) {
      const updated = await api.updateHomeFloor(floorModal.id, { name: floorName.trim() });
      setFloors((prev) => (prev ? prev.map((f) => (f.id === updated.id ? updated : f)) : prev));
    }
    setFloorModal(null);
  }

  async function confirmDeleteFloor() {
    if (!deletingFloor) return;
    await api.deleteHomeFloor(deletingFloor.id);
    setDeletingFloor(null);
    setFloorModal(null);
    reload();
  }

  if (error) return <div className="empty-state">Couldn't load Home: {error}</div>;
  if (!floors) return <div className="empty-state">Loading…</div>;

  // Resolve the selection to a floor (+ room) for the canvas.
  let activeFloor: HomeFloor | null = null;
  let activeRoom: HomeRoom | null = null;
  if (selection.startsWith('room:')) {
    const id = selection.slice(5);
    for (const f of floors) {
      const r = roomsByFloor[f.id]?.find((rm) => rm.id === id);
      if (r) {
        activeFloor = f;
        activeRoom = r;
        break;
      }
    }
  } else if (selection.startsWith('floor:')) {
    activeFloor = floors.find((f) => f.id === selection.slice(6)) ?? null;
  }
  const isElectrical = selection === 'electrical';
  const roomCount = floors.reduce((n, f) => n + (roomsByFloor[f.id]?.length ?? 0), 0);

  const floorMenu = [
    { label: 'Add Floor', onClick: openAddFloor },
    ...(activeFloor
      ? [
          { label: `Rename “${activeFloor.name}”`, onClick: () => openEditFloor(activeFloor!) },
          { label: `Delete “${activeFloor.name}”`, onClick: () => setDeletingFloor(activeFloor), danger: true, separatorBefore: true },
        ]
      : []),
  ];

  return (
    <div className="home-page">
      <div className="toolbar-row">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
          Home
        </h1>
      </div>

      <div className="bar-tabs home-page__nav">
        <label className={`home-room-picker${!isElectrical ? ' is-active' : ''}`}>
          <span className="home-room-picker__label">
            <span aria-hidden>🏠</span> Rooms
          </span>
          <select
            value={isElectrical ? '' : selection}
            onChange={(e) => e.target.value && setSelection(e.target.value as Selection)}
            disabled={floors.length === 0}
            aria-label="Room"
          >
            {(isElectrical || floors.length === 0) && (
              <option value="" disabled hidden>
                {floors.length === 0 ? 'No Rooms Yet' : roomCount ? `Choose a Room (${roomCount})` : 'Choose a Floor'}
              </option>
            )}
            {floors.map((f) => {
              const rooms = roomsByFloor[f.id] ?? [];
              return (
                <optgroup key={f.id} label={f.name}>
                  {rooms.length === 0 ? (
                    <option value={`floor:${f.id}`}>No Rooms Yet</option>
                  ) : (
                    rooms.map((r) => (
                      <option key={r.id} value={`room:${r.id}`}>
                        {r.name}
                      </option>
                    ))
                  )}
                </optgroup>
              );
            })}
          </select>
        </label>

        <button type="button" className={`bar-tabs__tab${isElectrical ? ' is-active' : ''}`} onClick={() => setSelection('electrical')}>
          <span>⚡</span> Electrical
        </button>

        <div className="home-page__floor-menu" title="Floors">
          <KebabMenu items={floorMenu} />
        </div>
      </div>

      <div className="home-page__body">
        {isElectrical ? (
          <HomeElectricalPage />
        ) : floors.length === 0 ? (
          <div className="empty-state empty-state--section">
            No rooms yet. Rooms are grouped by floor —{' '}
            <button type="button" className="btn btn--ghost btn--sm" onClick={openAddFloor}>
              Add Floor
            </button>{' '}
            first (Basement, 1st Floor, whatever you've got), then Add Room.
          </div>
        ) : activeFloor ? (
          <HomeFloorCanvas
            key={`${activeFloor.id}:${activeRoom?.id ?? ''}`}
            floorId={activeFloor.id}
            roomId={activeRoom?.id ?? null}
            floors={floors}
            onRoomsChanged={reload}
            onSelectRoom={(id) => setSelection(`room:${id}`)}
          />
        ) : (
          <div className="empty-state">Loading…</div>
        )}
      </div>

      {floorModal && (
        <Modal title={floorModal === 'new' ? 'Add Floor' : `Rename "${floorModal.name}"`} onClose={() => setFloorModal(null)}>
          <label className="wallet-editor__field">
            <span>Name</span>
            <input autoFocus value={floorName} onChange={(e) => setFloorName(e.target.value)} placeholder="e.g. Basement, 1st Floor, Attic" />
          </label>
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => setFloorModal(null)}>
              Cancel
            </button>
            <button className="btn" onClick={saveFloor} disabled={!floorName.trim()}>
              {floorModal === 'new' ? 'Add' : 'Save'}
            </button>
          </div>
        </Modal>
      )}

      {deletingFloor && (
        <ConfirmModal
          title="Delete this floor?"
          body={`"${deletingFloor.name}" and every room and fixture on it will be permanently deleted. Any linked Vault entries are kept.`}
          onConfirm={confirmDeleteFloor}
          onCancel={() => setDeletingFloor(null)}
        />
      )}
    </div>
  );
}

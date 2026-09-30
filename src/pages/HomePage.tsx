import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { HomeFloor } from '../api/types';
import { ConfirmModal } from '../components/ConfirmModal';
import { HomeElectricalPage } from '../components/HomeElectricalPage';
import { HomeFloorCanvas } from '../components/HomeFloorCanvas';
import { KebabMenu } from '../components/KebabMenu';
import { Modal } from '../components/Modal';
import { useReportTabMeta } from '../contexts/TabsContext';

type Tab = string | 'electrical'; // string = a floor id

/** Home — a to-scale digital floor plan: floors, each with a zoomable
 * to-scale room canvas (HomeFloorCanvas), plus a fixed Electrical tab for
 * panels/breakers. See worker/migrations/0077_home.sql for the data model
 * rationale. */
export function HomePage() {
  const [floors, setFloors] = useState<HomeFloor[] | null>(null);
  const [tab, setTab] = useState<Tab>('electrical');
  const [error, setError] = useState<string | null>(null);

  const [floorModal, setFloorModal] = useState<'new' | HomeFloor | null>(null);
  const [floorName, setFloorName] = useState('');
  const [deletingFloor, setDeletingFloor] = useState<HomeFloor | null>(null);

  useReportTabMeta('Home', 'home-list');

  const loadFloors = useCallback(() => {
    api
      .listHomeFloors()
      .then((list) => {
        setFloors(list);
        setTab((prev) => (prev === 'electrical' ? prev : list.some((f) => f.id === prev) ? prev : list[0]?.id ?? 'electrical'));
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    loadFloors();
  }, [loadFloors]);

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
      setTab(created.id);
    } else if (floorModal) {
      const updated = await api.updateHomeFloor(floorModal.id, { name: floorName.trim() });
      setFloors((prev) => (prev ? prev.map((f) => (f.id === updated.id ? updated : f)) : prev));
    }
    setFloorModal(null);
  }

  async function confirmDeleteFloor() {
    if (!deletingFloor) return;
    setFloors((prev) => (prev ? prev.filter((f) => f.id !== deletingFloor.id) : prev));
    if (tab === deletingFloor.id) setTab('electrical');
    await api.deleteHomeFloor(deletingFloor.id);
    setDeletingFloor(null);
    setFloorModal(null);
  }

  if (error) return <div className="empty-state">Couldn't load Home: {error}</div>;
  if (!floors) return <div className="empty-state">Loading…</div>;

  const activeFloor = floors.find((f) => f.id === tab) ?? null;

  return (
    <div>
      <div className="toolbar-row">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
          Home
        </h1>
        <button className="btn btn--ghost" onClick={openAddFloor}>
          + Add Floor
        </button>
      </div>

      <div className="bar-tabs">
        {floors.map((f) => (
          <button key={f.id} type="button" className={`bar-tabs__tab${tab === f.id ? ' is-active' : ''}`} onClick={() => setTab(f.id)}>
            <span>🏠</span> {f.name}
            {tab === f.id && (
              <KebabMenu
                items={[
                  { label: 'Rename Floor', onClick: () => openEditFloor(f) },
                  { label: 'Delete Floor', onClick: () => setDeletingFloor(f), danger: true, separatorBefore: true },
                ]}
              />
            )}
          </button>
        ))}
        <button key="electrical" type="button" className={`bar-tabs__tab${tab === 'electrical' ? ' is-active' : ''}`} onClick={() => setTab('electrical')}>
          <span>⚡</span> Electrical
        </button>
      </div>

      {floors.length === 0 && tab !== 'electrical' ? (
        <div className="empty-state empty-state--section">No floors yet — Add Floor to start mapping your house (Basement, 1st Floor, whatever you've got).</div>
      ) : tab === 'electrical' ? (
        <HomeElectricalPage />
      ) : activeFloor ? (
        <HomeFloorCanvas key={activeFloor.id} floorId={activeFloor.id} />
      ) : null}

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

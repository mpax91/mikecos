import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ElectricalBreakerWithFixtures, ElectricalPanel } from '../api/types';
import { ConfirmModal } from './ConfirmModal';
import { Modal } from './Modal';

const FIXTURE_TYPE_ICON: Record<string, string> = { appliance: '🔌', furniture: '🪑', outlet: '⏚', switch: '💡', fixture: '✦' };

/** Electrical panels + breakers, and — the whole point — a reverse lookup
 * of what's actually assigned to each breaker. Useful two ways: click an
 * outlet on the floor map to see its breaker (HomeFixtureModal), or come
 * here first to see everything on breaker #14 before you flip it. */
export function HomeElectricalPage() {
  const [panels, setPanels] = useState<ElectricalPanel[] | null>(null);
  const [activePanelId, setActivePanelId] = useState<string | null>(null);
  const [breakers, setBreakers] = useState<ElectricalBreakerWithFixtures[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [panelModal, setPanelModal] = useState<'new' | ElectricalPanel | null>(null);
  const [panelName, setPanelName] = useState('');
  const [panelLocation, setPanelLocation] = useState('');
  const [deletingPanel, setDeletingPanel] = useState<ElectricalPanel | null>(null);

  const [breakerModal, setBreakerModal] = useState<'new' | ElectricalBreakerWithFixtures | null>(null);
  const [breakerNumber, setBreakerNumber] = useState('');
  const [breakerLabel, setBreakerLabel] = useState('');
  const [breakerAmps, setBreakerAmps] = useState('');
  const [deletingBreaker, setDeletingBreaker] = useState<ElectricalBreakerWithFixtures | null>(null);

  const loadPanels = useCallback(() => {
    api
      .listElectricalPanels()
      .then((list) => {
        setPanels(list);
        setActivePanelId((prev) => prev ?? list[0]?.id ?? null);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    loadPanels();
  }, [loadPanels]);

  const loadBreakers = useCallback(() => {
    if (!activePanelId) {
      setBreakers(null);
      return;
    }
    api
      .listElectricalBreakers(activePanelId)
      .then(setBreakers)
      .catch((e) => setError(String(e)));
  }, [activePanelId]);

  useEffect(() => {
    loadBreakers();
  }, [loadBreakers]);

  function openAddPanel() {
    setPanelName('');
    setPanelLocation('');
    setPanelModal('new');
  }

  function openEditPanel(p: ElectricalPanel) {
    setPanelName(p.name);
    setPanelLocation(p.locationNotes ?? '');
    setPanelModal(p);
  }

  async function savePanel() {
    if (!panelName.trim()) return;
    if (panelModal === 'new') {
      const created = await api.createElectricalPanel({ name: panelName.trim(), locationNotes: panelLocation.trim() || null });
      setPanels((prev) => (prev ? [...prev, created] : [created]));
      setActivePanelId(created.id);
    } else if (panelModal) {
      const updated = await api.updateElectricalPanel(panelModal.id, { name: panelName.trim(), locationNotes: panelLocation.trim() || null });
      setPanels((prev) => (prev ? prev.map((p) => (p.id === updated.id ? updated : p)) : prev));
    }
    setPanelModal(null);
  }

  async function confirmDeletePanel() {
    if (!deletingPanel) return;
    setPanels((prev) => (prev ? prev.filter((p) => p.id !== deletingPanel.id) : prev));
    if (activePanelId === deletingPanel.id) setActivePanelId(null);
    await api.deleteElectricalPanel(deletingPanel.id);
    setDeletingPanel(null);
    setPanelModal(null);
  }

  function openAddBreaker() {
    setBreakerNumber('');
    setBreakerLabel('');
    setBreakerAmps('');
    setBreakerModal('new');
  }

  function openEditBreaker(b: ElectricalBreakerWithFixtures) {
    setBreakerNumber(b.number);
    setBreakerLabel(b.label ?? '');
    setBreakerAmps(b.amperage != null ? String(b.amperage) : '');
    setBreakerModal(b);
  }

  async function saveBreaker() {
    if (!activePanelId || !breakerNumber.trim()) return;
    const amperage = breakerAmps.trim() ? Number(breakerAmps) : null;
    if (breakerModal === 'new') {
      await api.createElectricalBreaker(activePanelId, { number: breakerNumber.trim(), label: breakerLabel.trim() || null, amperage });
    } else if (breakerModal) {
      await api.updateElectricalBreaker(breakerModal.id, { number: breakerNumber.trim(), label: breakerLabel.trim() || null, amperage });
    }
    setBreakerModal(null);
    loadBreakers();
  }

  async function confirmDeleteBreaker() {
    if (!deletingBreaker) return;
    await api.deleteElectricalBreaker(deletingBreaker.id);
    setDeletingBreaker(null);
    setBreakerModal(null);
    loadBreakers();
  }

  if (error) return <div className="empty-state">Couldn't load Electrical: {error}</div>;
  if (!panels) return <div className="empty-state">Loading…</div>;

  const activePanel = panels.find((p) => p.id === activePanelId) ?? null;

  return (
    <div>
      <div className="toolbar-row">
        <div className="home-electrical__panel-tabs">
          {panels.map((p) => (
            <button key={p.id} type="button" className={`bar-tabs__tab${activePanelId === p.id ? ' is-active' : ''}`} onClick={() => setActivePanelId(p.id)}>
              {p.name}
            </button>
          ))}
        </div>
        <button className="btn btn--ghost" onClick={openAddPanel}>
          + Add Panel
        </button>
      </div>

      {panels.length === 0 ? (
        <div className="empty-state empty-state--section">No electrical panels yet — add your main panel (and a subpanel, if you have one) to start mapping breakers.</div>
      ) : activePanel ? (
        <>
          <div className="toolbar-row" style={{ marginTop: 16 }}>
            <div>
              <div style={{ fontWeight: 'var(--weight-medium)' }}>{activePanel.name}</div>
              {activePanel.locationNotes && <div className="bar-item-card__meta">{activePanel.locationNotes}</div>}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn--ghost" onClick={() => openEditPanel(activePanel)}>
                Edit Panel
              </button>
              <button className="btn" onClick={openAddBreaker}>
                + Add Breaker
              </button>
            </div>
          </div>

          {!breakers ? (
            <div className="empty-state">Loading…</div>
          ) : breakers.length === 0 ? (
            <div className="empty-state empty-state--section">No breakers logged for this panel yet.</div>
          ) : (
            <div className="home-breaker-list">
              {breakers.map((b) => (
                <div key={b.id} className="home-breaker-row">
                  <div className="home-breaker-row__main" onClick={() => openEditBreaker(b)}>
                    <span className="home-breaker-row__number">#{b.number}</span>
                    <span className="home-breaker-row__label">{b.label || <em>Unlabeled</em>}</span>
                    {b.amperage != null && <span className="home-breaker-row__amps">{b.amperage}A</span>}
                  </div>
                  <div className="home-breaker-row__fixtures">
                    {b.fixtures.length === 0 ? (
                      <span className="home-breaker-row__empty">Nothing assigned</span>
                    ) : (
                      b.fixtures.map((f) => (
                        <span key={f.id} className="chip chip--static">
                          {FIXTURE_TYPE_ICON[f.type]} {f.label} <span className="home-breaker-row__fixture-loc">({f.floorName} · {f.roomName})</span>
                        </span>
                      ))
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : null}

      {panelModal && (
        <Modal title={panelModal === 'new' ? 'Add Panel' : `Edit "${panelModal.name}"`} onClose={() => setPanelModal(null)}>
          <label className="wallet-editor__field">
            <span>Name</span>
            <input autoFocus value={panelName} onChange={(e) => setPanelName(e.target.value)} placeholder="e.g. Main Panel, Garage Subpanel" />
          </label>
          <label className="wallet-editor__field">
            <span>Location</span>
            <input value={panelLocation} onChange={(e) => setPanelLocation(e.target.value)} placeholder="e.g. Basement utility room" />
          </label>
          <div className="modal__actions">
            {panelModal !== 'new' && (
              <button className="btn btn--ghost" style={{ color: 'var(--color-danger, #c0392b)', marginRight: 'auto' }} onClick={() => setDeletingPanel(panelModal)}>
                Delete
              </button>
            )}
            <button className="btn btn--ghost" onClick={() => setPanelModal(null)}>
              Cancel
            </button>
            <button className="btn" onClick={savePanel} disabled={!panelName.trim()}>
              {panelModal === 'new' ? 'Add' : 'Save'}
            </button>
          </div>
        </Modal>
      )}

      {deletingPanel && (
        <ConfirmModal
          title="Delete this panel?"
          body={`"${deletingPanel.name}" and its breakers will be deleted. Outlets/switches assigned to them become unassigned rather than being deleted.`}
          onConfirm={confirmDeletePanel}
          onCancel={() => setDeletingPanel(null)}
        />
      )}

      {breakerModal && (
        <Modal title={breakerModal === 'new' ? 'Add Breaker' : `Edit Breaker #${breakerModal.number}`} onClose={() => setBreakerModal(null)}>
          <div className="bar-item-modal__row">
            <label className="wallet-editor__field">
              <span>Number</span>
              <input autoFocus value={breakerNumber} onChange={(e) => setBreakerNumber(e.target.value)} placeholder="14" />
            </label>
            <label className="wallet-editor__field">
              <span>Amperage</span>
              <input type="number" value={breakerAmps} onChange={(e) => setBreakerAmps(e.target.value)} placeholder="20" />
            </label>
          </div>
          <label className="wallet-editor__field">
            <span>Label</span>
            <input value={breakerLabel} onChange={(e) => setBreakerLabel(e.target.value)} placeholder="e.g. Kitchen Outlets" />
          </label>
          <div className="modal__actions">
            {breakerModal !== 'new' && (
              <button className="btn btn--ghost" style={{ color: 'var(--color-danger, #c0392b)', marginRight: 'auto' }} onClick={() => setDeletingBreaker(breakerModal)}>
                Delete
              </button>
            )}
            <button className="btn btn--ghost" onClick={() => setBreakerModal(null)}>
              Cancel
            </button>
            <button className="btn" onClick={saveBreaker} disabled={!breakerNumber.trim()}>
              {breakerModal === 'new' ? 'Add' : 'Save'}
            </button>
          </div>
        </Modal>
      )}

      {deletingBreaker && (
        <ConfirmModal
          title="Delete this breaker?"
          body={`Breaker #${deletingBreaker.number} will be deleted. Anything assigned to it becomes unassigned rather than being deleted.`}
          onConfirm={confirmDeleteBreaker}
          onCancel={() => setDeletingBreaker(null)}
        />
      )}
    </div>
  );
}

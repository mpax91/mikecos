import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { BarItem, BarItemDetail, BarItemType, BarTopTastingEntry } from '../api/types';
import { Modal } from '../components/Modal';
import { ConfirmModal } from '../components/ConfirmModal';
import { KebabMenu } from '../components/KebabMenu';
import { StarRating } from '../components/StarRating';
import { BarItemModal, type BarItemFormValue } from '../components/BarItemModal';
import { BarTastingHistoryModal } from '../components/BarTastingHistoryModal';
import type { TastingFormValue } from '../components/BarTastingModal';
import { useReportTabMeta } from '../contexts/TabsContext';

type Tab = BarItemType | 'top';

const TAB_META: Record<Tab, { label: string; icon: string; addLabel: string }> = {
  spirit: { label: 'Spirits', icon: '🥃', addLabel: '+ Add a Spirit' },
  wine: { label: 'Wine', icon: '🍷', addLabel: '+ Add a Wine' },
  beer: { label: 'Beer', icon: '🍺', addLabel: '+ Add a Beer' },
  top: { label: 'Top Rated', icon: '⭐', addLabel: '' },
};

function parseBulkLines(text: string): { name: string; category: string | null }[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.includes('\t') ? line.split('\t') : line.split(' | ');
      return { name: parts[0].trim(), category: parts[1]?.trim() || null };
    })
    .filter((r) => r.name);
}

/** The Bar — home spirits/wine/beer inventory plus a Vivino/Untappd-style
 * tasting log for wine (and, if he ever gets to it, beer). See
 * worker/migrations/0075_bar.sql for the data model: one shared items
 * table across all three types, a separate tastings table so a wine's
 * score history survives its last bottle being gone. */
export function BarPage() {
  const [tab, setTab] = useState<Tab>('wine');
  const [items, setItems] = useState<BarItem[] | null>(null);
  const [topTastings, setTopTastings] = useState<BarTopTastingEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<BarItem | null>(null);
  const [deleting, setDeleting] = useState<BarItem | null>(null);
  const [tastingHistoryFor, setTastingHistoryFor] = useState<BarItemDetail | null>(null);

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkImporting, setBulkImporting] = useState(false);
  const [bulkDone, setBulkDone] = useState<number | null>(null);

  useReportTabMeta('Bar', 'bar-list');

  const loadItems = useCallback(() => {
    api.listBarItems().then(setItems).catch((e) => setError(String(e)));
  }, []);

  const loadTop = useCallback(() => {
    api.getTopBarTastings({ limit: 100 }).then(setTopTastings).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  useEffect(() => {
    if (tab === 'top') loadTop();
  }, [tab, loadTop]);

  async function handleAdd(value: BarItemFormValue) {
    await api.createBarItem(value);
    setAdding(false);
    loadItems();
  }

  async function handleEdit(value: BarItemFormValue) {
    if (!editing) return;
    await api.updateBarItem(editing.id, value);
    setEditing(null);
    loadItems();
  }

  async function handleDelete(item: BarItem) {
    setItems((prev) => (prev ? prev.filter((i) => i.id !== item.id) : prev));
    await api.deleteBarItem(item.id);
    setDeleting(null);
  }

  async function adjustQuantity(item: BarItem, delta: number) {
    const updated = await api.adjustBarItemQuantity(item.id, delta);
    setItems((prev) => (prev ? prev.map((i) => (i.id === item.id ? updated : i)) : prev));
  }

  async function openTastingHistory(item: BarItem) {
    const detail = await api.getBarItem(item.id);
    setTastingHistoryFor(detail);
  }

  async function handleCreateTasting(value: TastingFormValue) {
    if (!tastingHistoryFor) return;
    await api.createBarTasting(tastingHistoryFor.id, value);
    const detail = await api.getBarItem(tastingHistoryFor.id);
    setTastingHistoryFor(detail);
  }

  async function handleUpdateTasting(id: string, value: TastingFormValue) {
    if (!tastingHistoryFor) return;
    await api.updateBarTasting(id, value);
    const detail = await api.getBarItem(tastingHistoryFor.id);
    setTastingHistoryFor(detail);
  }

  async function handleDeleteTasting(id: string) {
    if (!tastingHistoryFor) return;
    await api.deleteBarTasting(id);
    const detail = await api.getBarItem(tastingHistoryFor.id);
    setTastingHistoryFor(detail);
  }

  function openBulk() {
    setBulkText('');
    setBulkError(null);
    setBulkDone(null);
    setBulkOpen(true);
  }

  const bulkRows = parseBulkLines(bulkText);
  const bulkType = tab === 'top' ? 'wine' : tab; // Bulk Import isn't shown on the Top Rated tab, but keep TS happy

  async function handleBulkImport() {
    if (bulkRows.length === 0 || tab === 'top') return;
    setBulkImporting(true);
    setBulkError(null);
    try {
      const res = await api.bulkCreateBarItems(bulkType, bulkRows);
      setBulkDone(res.created);
      setBulkText('');
      loadItems();
    } catch (e) {
      setBulkError(String(e));
    } finally {
      setBulkImporting(false);
    }
  }

  if (error) return <div className="empty-state">Couldn't load the Bar: {error}</div>;

  const shown = tab === 'top' ? [] : (items ?? []).filter((i) => i.type === tab);

  return (
    <div>
      <div className="toolbar-row">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
          Bar
        </h1>
        {tab !== 'top' && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn--ghost" onClick={openBulk}>
              Bulk Import
            </button>
            <button className="btn" onClick={() => setAdding(true)}>
              {TAB_META[tab].addLabel}
            </button>
          </div>
        )}
      </div>

      <div className="bar-tabs">
        {(Object.keys(TAB_META) as Tab[]).map((t) => (
          <button key={t} type="button" className={`bar-tabs__tab${tab === t ? ' is-active' : ''}`} onClick={() => setTab(t)}>
            <span>{TAB_META[t].icon}</span> {TAB_META[t].label}
            {t !== 'top' && items && <span className="bar-tabs__count">{items.filter((i) => i.type === t).length}</span>}
          </button>
        ))}
      </div>

      {tab === 'top' ? (
        !topTastings ? (
          <div className="empty-state">Loading…</div>
        ) : topTastings.length === 0 ? (
          <div className="empty-state empty-state--section">
            No scored tastings yet — log one from Wine, Spirits, or Beer and your highest-rated picks will show up here, even after you're
            out of stock.
          </div>
        ) : (
          <div className="bar-top-list">
            {topTastings.map((t) => (
              <div key={t.id} className="bar-top-list__row">
                <div className="bar-top-list__main">
                  <span className="bar-top-list__name">
                    {t.item.name}
                    {t.item.vintage ? ` (${t.item.vintage})` : ''}
                  </span>
                  <span className="bar-top-list__meta">
                    {[TAB_META[t.item.type].icon, t.item.category, t.item.producer, t.item.region].filter(Boolean).join(' · ')}
                  </span>
                </div>
                <div className="bar-top-list__score">
                  <StarRating value={t.score} readOnly size={16} />
                </div>
                <div className="bar-top-list__stock">{t.item.quantity > 0 ? `${t.item.quantity} on hand` : 'Out of stock'}</div>
              </div>
            ))}
          </div>
        )
      ) : !items ? (
        <div className="empty-state">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="empty-state empty-state--section">
          Nothing here yet — {TAB_META[tab].addLabel.toLowerCase()} or use Bulk Import to get your {TAB_META[tab].label.toLowerCase()} rack
          in quickly.
        </div>
      ) : (
        <div className="bar-item-grid">
          {shown.map((item) => (
            <div key={item.id} className="bar-item-card">
              <div className="bar-item-card__header">
                <div>
                  <div className="bar-item-card__name">
                    {item.name}
                    {item.vintage ? ` (${item.vintage})` : ''}
                  </div>
                  <div className="bar-item-card__meta">{[item.category, item.producer, item.region].filter(Boolean).join(' · ')}</div>
                  {(item.drinkWindowStart || item.drinkWindowEnd) && (
                    <div className="bar-item-card__window">
                      Drink {item.drinkWindowStart ?? '?'}–{item.drinkWindowEnd ?? '?'}
                    </div>
                  )}
                </div>
                <KebabMenu
                  items={[
                    { label: 'Edit', onClick: () => setEditing(item) },
                    { label: 'Tastings', onClick: () => openTastingHistory(item) },
                    { label: 'Delete', onClick: () => setDeleting(item), danger: true, separatorBefore: true },
                  ]}
                />
              </div>
              {item.notes && <div className="bar-item-card__notes">{item.notes}</div>}
              <div className="bar-item-card__footer">
                <div className="bar-item-card__qty">
                  <button type="button" onClick={() => adjustQuantity(item, -1)} disabled={item.quantity <= 0} aria-label="Decrease quantity">
                    −
                  </button>
                  <span>{item.quantity}</span>
                  <button type="button" onClick={() => adjustQuantity(item, 1)} aria-label="Increase quantity">
                    +
                  </button>
                </div>
                <button type="button" className="bar-item-card__tastings-link" onClick={() => openTastingHistory(item)}>
                  Tastings
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {adding && <BarItemModal type={tab === 'top' ? 'wine' : tab} onSave={handleAdd} onClose={() => setAdding(false)} />}

      {editing && <BarItemModal type={editing.type} initial={editing} onSave={handleEdit} onClose={() => setEditing(null)} />}

      {deleting && (
        <ConfirmModal
          title="Delete this item?"
          body={`"${deleting.name}" and its tasting history will be permanently deleted.`}
          onConfirm={() => handleDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}

      {tastingHistoryFor && (
        <BarTastingHistoryModal
          item={tastingHistoryFor}
          tastings={tastingHistoryFor.tastings}
          onCreate={handleCreateTasting}
          onUpdate={handleUpdateTasting}
          onDelete={handleDeleteTasting}
          onClose={() => setTastingHistoryFor(null)}
        />
      )}

      {bulkOpen && tab !== 'top' && (
        <Modal title="Bulk Import" onClose={() => setBulkOpen(false)}>
          <p className="settings-page__section-hint" style={{ marginTop: 0 }}>
            Paste one {TAB_META[tab].label.toLowerCase()} per line — a name alone is fine, or paste two columns (name, then{' '}
            {tab === 'wine' ? 'varietal' : tab === 'beer' ? 'style' : 'category'}) straight out of a spreadsheet and the tab between them is
            picked up automatically. Typing by hand, separate them with <code>|</code>. Each is added with quantity 1 — adjust after import.
          </p>
          <label className="wallet-editor__field">
            <span>{TAB_META[tab].label}</span>
            <textarea
              autoFocus
              value={bulkText}
              onChange={(e) => {
                setBulkText(e.target.value);
                setBulkDone(null);
              }}
              rows={10}
              placeholder={tab === 'wine' ? 'Produttori del Barbaresco\nSchramsberg Blanc de Blancs | Sparkling' : tab === 'spirit' ? "Hendrick's Gin\nBuffalo Trace | Bourbon" : 'Sierra Nevada Pale Ale\nGuinness | Stout'}
              style={{ fontFamily: 'monospace', fontSize: 12.5 }}
            />
          </label>
          <div className="wallet-editor__hint">
            {bulkRows.length > 0 ? `${bulkRows.length.toLocaleString()} item${bulkRows.length === 1 ? '' : 's'} will be added.` : 'Nothing to import yet.'}
          </div>
          {bulkDone !== null && <div className="wallet-editor__hint">Added {bulkDone.toLocaleString()} items.</div>}
          {bulkError && <div className="settings-page__rrule-error">{bulkError}</div>}
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => setBulkOpen(false)}>
              {bulkDone !== null ? 'Done' : 'Cancel'}
            </button>
            <button className="btn" onClick={handleBulkImport} disabled={bulkRows.length === 0 || bulkImporting}>
              {bulkImporting ? 'Importing…' : `Import ${bulkRows.length > 0 ? bulkRows.length.toLocaleString() : ''}`}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

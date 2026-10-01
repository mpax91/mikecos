import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { BarItem, BarItemDetail, BarItemType, BarTopTastingEntry } from '../api/types';
import { Modal } from '../components/Modal';
import { ConfirmModal } from '../components/ConfirmModal';
import { StarRating } from '../components/StarRating';
import { BarItemModal, type BarItemFormValue } from '../components/BarItemModal';
import { BarItemDetailModal } from '../components/BarItemDetailModal';
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
  const [detailFor, setDetailFor] = useState<BarItem | null>(null);
  const [tastingHistoryFor, setTastingHistoryFor] = useState<BarItemDetail | null>(null);
  const [search, setSearch] = useState('');
  const [colorFilter, setColorFilter] = useState<string | null>(null);
  const [geoFilter, setGeoFilter] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkImporting, setBulkImporting] = useState(false);
  const [bulkDone, setBulkDone] = useState<number | null>(null);

  useReportTabMeta('Bar', 'bar-list');

  // Filters are scoped to whichever tab is open (a Color pick on Wine means
  // nothing on Spirits) — switching tabs clears them rather than carrying
  // over a filter that'd just silently empty the next tab's grid.
  function switchTab(t: Tab) {
    setTab(t);
    setSearch('');
    setColorFilter(null);
    setGeoFilter(null);
    setCategoryFilter(null);
  }

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
    // Keeps the stepper inside an open detail modal in sync with itself —
    // it reads `detailFor`'s own quantity, not the grid tile behind it.
    setDetailFor((prev) => (prev && prev.id === item.id ? updated : prev));
  }

  // The detail modal is a hub, not a layer other modals stack on top of —
  // each action transitions away from it rather than opening alongside it.
  function handleEditFromDetail() {
    if (!detailFor) return;
    setEditing(detailFor);
    setDetailFor(null);
  }

  function handleDeleteFromDetail() {
    if (!detailFor) return;
    setDeleting(detailFor);
    setDetailFor(null);
  }

  async function handleTastingsFromDetail() {
    if (!detailFor) return;
    await openTastingHistory(detailFor);
    setDetailFor(null);
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

  const byTab = tab === 'top' ? [] : (items ?? []).filter((i) => i.type === tab);

  // Filter chip options are drawn from what's actually in this tab's rack
  // rather than the full fixed dropdown vocab — no point offering a Geo
  // chip for a country Mike has zero bottles from.
  function uniqueSorted(values: (string | null)[]): string[] {
    return Array.from(new Set(values.filter((v): v is string => !!v))).sort((a, b) => a.localeCompare(b));
  }
  const colorOptions = tab === 'wine' ? uniqueSorted(byTab.map((i) => i.color)) : [];
  const geoOptions = tab === 'wine' ? uniqueSorted(byTab.map((i) => i.geo)) : [];
  const categoryOptions = uniqueSorted(byTab.map((i) => i.category));
  const categoryFilterLabel = tab === 'wine' ? 'Type' : tab === 'beer' ? 'Style' : 'Category';

  let filtered = byTab;
  if (colorFilter) filtered = filtered.filter((i) => i.color === colorFilter);
  if (geoFilter) filtered = filtered.filter((i) => i.geo === geoFilter);
  if (categoryFilter) filtered = filtered.filter((i) => i.category === categoryFilter);
  const searchQuery = search.trim().toLowerCase();
  const shown = searchQuery
    ? filtered.filter((i) => [i.name, i.category, i.producer, i.color, i.geo].filter(Boolean).join(' ').toLowerCase().includes(searchQuery))
    : filtered;
  const filtersActive = Boolean(search.trim() || colorFilter || geoFilter || categoryFilter);

  function clearFilters() {
    setSearch('');
    setColorFilter(null);
    setGeoFilter(null);
    setCategoryFilter(null);
  }

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
          <button key={t} type="button" className={`bar-tabs__tab${tab === t ? ' is-active' : ''}`} onClick={() => switchTab(t)}>
            <span>{TAB_META[t].icon}</span> {TAB_META[t].label}
            {t !== 'top' && items && <span className="bar-tabs__count">{items.filter((i) => i.type === t).length}</span>}
          </button>
        ))}
      </div>

      {tab !== 'top' && (
        <input
          type="search"
          className="wallet-page__search"
          placeholder={`Search ${TAB_META[tab].label.toLowerCase()}…`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}

      {tab !== 'top' && byTab.length > 0 && (categoryOptions.length > 1 || colorOptions.length > 1 || geoOptions.length > 1) && (
        <div className="bar-filters">
          {colorOptions.length > 1 && (
            <div className="bar-filters__group">
              <span className="bar-filters__label">Color</span>
              <div className="wallet-page__chips">
                <button type="button" className={`wallet-page__chip${colorFilter === null ? ' is-active' : ''}`} onClick={() => setColorFilter(null)}>
                  All
                </button>
                {colorOptions.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`wallet-page__chip${colorFilter === c ? ' is-active' : ''}`}
                    onClick={() => setColorFilter(colorFilter === c ? null : c)}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
          )}
          {geoOptions.length > 1 && (
            <div className="bar-filters__group">
              <span className="bar-filters__label">Geo</span>
              <div className="wallet-page__chips">
                <button type="button" className={`wallet-page__chip${geoFilter === null ? ' is-active' : ''}`} onClick={() => setGeoFilter(null)}>
                  All
                </button>
                {geoOptions.map((g) => (
                  <button
                    key={g}
                    type="button"
                    className={`wallet-page__chip${geoFilter === g ? ' is-active' : ''}`}
                    onClick={() => setGeoFilter(geoFilter === g ? null : g)}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>
          )}
          {categoryOptions.length > 1 && (
            <div className="bar-filters__group">
              <span className="bar-filters__label">{categoryFilterLabel}</span>
              <div className="wallet-page__chips">
                <button
                  type="button"
                  className={`wallet-page__chip${categoryFilter === null ? ' is-active' : ''}`}
                  onClick={() => setCategoryFilter(null)}
                >
                  All
                </button>
                {categoryOptions.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`wallet-page__chip${categoryFilter === c ? ' is-active' : ''}`}
                    onClick={() => setCategoryFilter(categoryFilter === c ? null : c)}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

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
                    {[TAB_META[t.item.type].icon, t.item.color, t.item.geo, t.item.category, t.item.producer].filter(Boolean).join(' · ')}
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
      ) : byTab.length === 0 ? (
        <div className="empty-state empty-state--section">
          Nothing here yet — {TAB_META[tab].addLabel.toLowerCase()} or use Bulk Import to get your {TAB_META[tab].label.toLowerCase()} rack
          in quickly.
        </div>
      ) : shown.length === 0 ? (
        <div className="empty-state empty-state--section">
          No {TAB_META[tab].label.toLowerCase()} match{filtersActive ? ' these filters' : ''}
          {search.trim() ? ` "${search.trim()}"` : ''}.
          {filtersActive && (
            <>
              {' '}
              <button type="button" className="btn btn--ghost" onClick={clearFilters} style={{ marginLeft: 6 }}>
                Clear filters
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="bar-item-tile-grid">
          {shown.map((item) => (
            <button key={item.id} type="button" className="bar-item-tile" onClick={() => setDetailFor(item)}>
              <div className="bar-item-tile__photo-wrap">
                {item.photoKey ? (
                  <img
                    className={`bar-item-tile__photo${item.photoOrientation === 'landscape' ? ' bar-item-tile__photo--landscape' : ''}`}
                    src={api.fileUrl(item.photoKey)}
                    alt=""
                  />
                ) : (
                  <span className="bar-item-tile__photo-icon">{TAB_META[item.type].icon}</span>
                )}
                {item.quantity !== 1 && (
                  <span className={`bar-item-tile__qty-badge${item.quantity === 0 ? ' is-empty' : ''}`}>
                    {item.quantity === 0 ? 'Out' : item.quantity}
                  </span>
                )}
              </div>
              <div className="bar-item-tile__name">
                {item.name}
                {item.vintage ? ` (${item.vintage})` : ''}
              </div>
              {(item.color || item.category) && (
                <div className="bar-item-tile__sub">{[item.color, item.category].filter(Boolean).join(' · ')}</div>
              )}
            </button>
          ))}
        </div>
      )}

      {detailFor && (
        <BarItemDetailModal
          item={detailFor}
          onClose={() => setDetailFor(null)}
          onEdit={handleEditFromDetail}
          onDelete={handleDeleteFromDetail}
          onAdjustQuantity={(delta) => adjustQuantity(detailFor, delta)}
          onOpenTastings={handleTastingsFromDetail}
        />
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

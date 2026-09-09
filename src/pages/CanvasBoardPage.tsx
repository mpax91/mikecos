import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { CanvasBoard, CanvasConnector, CanvasItem, ImageItemContent, NoteItemContent, TextItemContent } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a straight line from a rect's center toward some other point
 * exits the rect's boundary — i.e. a good "arrow starts/ends at the edge
 * of the card, not floating in its middle" anchor point. Standard ray/box
 * intersection: scale the center-to-target vector down by whichever axis
 * hits its half-extent first. */
function edgePointToward(rect: Rect, towardX: number, towardY: number): { x: number; y: number } {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dx = towardX - cx;
  const dy = towardY - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const halfW = rect.width / 2 || 1;
  const halfH = rect.height / 2 || 1;
  const scale = 1 / Math.max(Math.abs(dx) / halfW, Math.abs(dy) / halfH);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

function rectContains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

/** Renders page 1 of a PDF onto a canvas as a lightweight preview — pdfjs
 * is a heavy dependency (~1MB), so it's only ever dynamically imported
 * here, the moment a board actually has a PDF item to show, rather than
 * bloating the main app bundle for everyone. Re-renders whenever the
 * item's box is resized so the preview stays crisp instead of just being
 * CSS-stretched. */
function PdfThumbnail({ url, width, height }: { url: string; width: number; height: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    (async () => {
      try {
        const pdfjsLib = await import('pdfjs-dist');
        const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
        const dpr = window.devicePixelRatio || 1;
        const pdf = await pdfjsLib.getDocument(url).promise;
        if (cancelled) return;
        const page = await pdf.getPage(1);
        const unscaledViewport = page.getViewport({ scale: 1 });
        const fitScale = Math.min(width / unscaledViewport.width, height / unscaledViewport.height);
        const viewport = page.getViewport({ scale: fitScale * dpr });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width / dpr}px`;
        canvas.style.height = `${viewport.height / dpr}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        await page.render({ canvasContext: ctx, viewport }).promise;
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, width, height]);

  if (failed) {
    return (
      <div className="canvas-item__file-fallback">
        <span className="canvas-item__file-icon">📄</span>
        <span className="canvas-item__file-name">Preview unavailable</span>
      </div>
    );
  }

  return (
    <div className="canvas-item__pdf-preview">
      <canvas ref={canvasRef} />
    </div>
  );
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 4;
const DEFAULT_IMAGE_SIZE = { width: 280, height: 210 };
const DEFAULT_PDF_SIZE = { width: 260, height: 336 }; // roughly a US Letter page's aspect ratio
const MAX_UPLOAD_DIMENSION = 480; // cap so a huge screenshot doesn't land as a giant item
const MIN_UPLOAD_DIMENSION = 160; // floor so a tiny icon isn't microscopic

/** Sizes a newly-dropped/pasted item so it lands at a legible size instead
 * of always the same fixed box: an image gets its true aspect ratio (fit
 * within a max/min box) so a wide screenshot isn't squashed into a near-
 * square frame and forced to shrink further just to read the text in it;
 * a PDF gets a page-shaped default since its real first-page size isn't
 * known until it's rendered. */
async function computeItemSize(file: File): Promise<{ width: number; height: number }> {
  if (file.type.startsWith('image/')) {
    try {
      const bitmap = await createImageBitmap(file);
      const { width: w, height: h } = bitmap;
      bitmap.close?.();
      if (w > 0 && h > 0) {
        const fit = Math.min(1, MAX_UPLOAD_DIMENSION / Math.max(w, h));
        let width = w * fit;
        let height = h * fit;
        if (Math.max(width, height) < MIN_UPLOAD_DIMENSION) {
          const grow = MIN_UPLOAD_DIMENSION / Math.max(width, height);
          width *= grow;
          height *= grow;
        }
        return { width, height };
      }
    } catch {
      // fall through to the generic default below
    }
  }
  if (file.type === 'application/pdf') return DEFAULT_PDF_SIZE;
  return DEFAULT_IMAGE_SIZE;
}
const DEFAULT_TEXT_SIZE = { width: 220, height: 90 };
const DEFAULT_NOTE_SIZE = { width: 200, height: 160 };
const MIN_ITEM_SIZE = 60;

const NOTE_COLORS = ['#F6DE7C', '#B9DDC7', '#F3C6C6', '#C9D9F3'];

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

interface Pan {
  x: number;
  y: number;
}

function parseContent<T>(raw: string, fallback: T): T {
  try {
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

/** One item on the canvas — positioned in world-space via left/top (the
 * parent .canvas-board__world div carries the pan/zoom transform, so every
 * item here just uses plain unscaled pixel coordinates and never has to
 * know about the current viewport itself). Dragging, resizing, and
 * double-click-to-edit are all handled here; the board page owns the
 * actual persistence (onDragEnd/onResizeEnd/onContentChange) and the
 * shared "which item is selected/editing" state, since only one item can
 * be selected or edited at a time. */
function CanvasItemView({
  item,
  selected,
  editing,
  onSelect,
  onDragStart,
  onResizeStart,
  onStartEdit,
  onContentChange,
  onStopEdit,
  onDelete,
  onConnectorHandleDown,
}: {
  item: CanvasItem;
  selected: boolean;
  editing: boolean;
  onSelect: (e: React.PointerEvent) => void;
  onDragStart: (e: React.PointerEvent) => void;
  onResizeStart: (e: React.PointerEvent) => void;
  onStartEdit: () => void;
  onContentChange: (text: string) => void;
  onStopEdit: () => void;
  onDelete: () => void;
  onConnectorHandleDown: (e: React.PointerEvent) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    }
  }, [editing]);

  const style: React.CSSProperties = {
    left: item.x,
    top: item.y,
    width: item.width,
    height: item.height,
    zIndex: item.z_index,
  };

  let body: React.ReactNode;
  if (item.type === 'image') {
    const meta = parseContent<ImageItemContent>(item.content, { r2_key: '', mime_type: '', filename: '' });
    const isImage = meta.mime_type.startsWith('image/');
    const isPdf = meta.mime_type === 'application/pdf';
    body = isImage ? (
      <img src={api.fileUrl(meta.r2_key)} alt={meta.filename} draggable={false} className="canvas-item__image" />
    ) : isPdf ? (
      <PdfThumbnail url={api.fileUrl(meta.r2_key)} width={item.width} height={item.height} />
    ) : (
      <div className="canvas-item__file-fallback" title={meta.filename}>
        <span className="canvas-item__file-icon">📎</span>
        <span className="canvas-item__file-name">{meta.filename}</span>
      </div>
    );
  } else if (item.type === 'text') {
    const meta = parseContent<TextItemContent>(item.content, { text: '' });
    body = editing ? (
      <textarea
        ref={textareaRef}
        className="canvas-item__textarea"
        value={meta.text}
        placeholder="Type something…"
        onChange={(e) => onContentChange(e.target.value)}
        onBlur={onStopEdit}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.currentTarget.blur();
          }
          e.stopPropagation();
        }}
      />
    ) : (
      <div className="canvas-item__text-display" onDoubleClick={onStartEdit}>
        {meta.text || <span className="canvas-item__placeholder">Double-click to edit…</span>}
      </div>
    );
  } else {
    const meta = parseContent<NoteItemContent>(item.content, { text: '', color: NOTE_COLORS[0] });
    body = editing ? (
      <textarea
        ref={textareaRef}
        className="canvas-item__textarea canvas-item__textarea--note"
        value={meta.text}
        placeholder="Type something…"
        onChange={(e) => onContentChange(e.target.value)}
        onBlur={onStopEdit}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') e.currentTarget.blur();
          e.stopPropagation();
        }}
      />
    ) : (
      <div className="canvas-item__text-display" onDoubleClick={onStartEdit}>
        {meta.text || <span className="canvas-item__placeholder">Double-click to edit…</span>}
      </div>
    );
  }

  const noteColor = item.type === 'note' ? parseContent<NoteItemContent>(item.content, { text: '', color: NOTE_COLORS[0] }).color : undefined;

  return (
    <div
      className={`canvas-item canvas-item--${item.type}${selected ? ' is-selected' : ''}`}
      style={{ ...style, ...(noteColor ? { background: noteColor } : {}) }}
      onPointerDown={(e) => {
        if (editing) return;
        onSelect(e);
        onDragStart(e);
      }}
      onDoubleClick={() => (item.type !== 'image' ? onStartEdit() : undefined)}
    >
      {body}
      {selected && !editing && (
        <>
          <button
            type="button"
            className="canvas-item__delete"
            title="Delete"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onDelete}
          >
            ✕
          </button>
          <div
            className="canvas-item__resize-handle"
            onPointerDown={(e) => {
              e.stopPropagation();
              onResizeStart(e);
            }}
          />
          {(['n', 'e', 's', 'w'] as const).map((side) => (
            <div
              key={side}
              className={`canvas-item__connector-handle canvas-item__connector-handle--${side}`}
              title="Drag to connect to another item"
              onPointerDown={(e) => {
                e.stopPropagation();
                onConnectorHandleDown(e);
              }}
            />
          ))}
        </>
      )}
    </div>
  );
}

/** The infinite canvas itself — a spatial pinboard distinct from every
 * other document-shaped view in this app. World-space coordinates live on
 * items (x/y/width/height, unbounded, can be negative); the viewport is
 * just a pan offset + zoom scale applied as a single CSS transform on the
 * .canvas-board__world wrapper, so panning/zooming is one GPU-accelerated
 * transform rather than recomputing every item's screen position on every
 * frame — this is what keeps it responsive with a lot of items.
 *
 * Connector arrows link two items by id only, no stored anchor point —
 * drag from one of a selected item's edge handles onto another item to
 * link them; the actual line endpoints are recomputed from each item's
 * live box every render (see edgePointToward above), which is what makes
 * an arrow "move with" its cards as they're dragged around, automatically.
 *
 * Still deliberately no multi-select/marquee — that's a separate round. */
export function CanvasBoardPage() {
  const { id } = useParams<{ id: string }>();
  const boardId = id!;

  const [board, setBoard] = useState<CanvasBoard | null>(null);
  const [items, setItems] = useState<CanvasItem[] | null>(null);
  const [connectors, setConnectors] = useState<CanvasConnector[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedConnectorId, setSelectedConnectorId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Live endpoint of an in-progress "drag a connector from this item"
  // gesture, in world coordinates — drives the dashed preview line. Kept
  // in React state (unlike the gesture ref below) because it needs to
  // trigger a re-render every pointermove to actually be visible.
  const [connectDraft, setConnectDraft] = useState<{ fromItemId: string; x: number; y: number } | null>(null);
  // pan and scale are kept in one state object (not two separate useState
  // calls) because wheel-zoom needs to compute a new scale AND a
  // compensating new pan together, atomically, from the same previous
  // values — two independent setState calls can't safely reference each
  // other's "next" value from inside their own updater function.
  const [view, setView] = useState<{ pan: Pan; scale: number }>({ pan: { x: 0, y: 0 }, scale: 1 });
  const { pan, scale } = view;
  // Mirrors `view` for the paste listener below, so that effect doesn't
  // need to re-subscribe its window listener on every single pan/zoom tick
  // (which fires on every wheel event) just to see a fresh pan/scale.
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const titleSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Drag/resize/pan all track their own live gesture state in a ref (not
  // React state) since they update on every pointermove — routing that
  // through setState would mean a re-render per pixel of mouse movement.
  const gesture = useRef<
    | { kind: 'pan'; startX: number; startY: number; startPan: Pan }
    | { kind: 'drag'; itemId: string; startX: number; startY: number; startItemX: number; startItemY: number }
    | { kind: 'resize'; itemId: string; startX: number; startY: number; startWidth: number; startHeight: number }
    | { kind: 'connect'; fromItemId: string; x: number; y: number }
    | null
  >(null);

  useReportTabMeta(board?.title || 'Board', 'board');

  const load = useCallback(() => {
    api
      .getBoard(boardId)
      .then((res) => {
        setBoard(res.board);
        setTitleDraft(res.board.title);
        setItems(res.items);
        setConnectors(res.connectors);
      })
      .catch((e) => setError(String(e)));
  }, [boardId]);

  useEffect(() => {
    load();
    setSelectedId(null);
    setSelectedConnectorId(null);
    setEditingId(null);
    setView({ pan: { x: 0, y: 0 }, scale: 1 });
  }, [load]);

  // Native (non-React) wheel listener with { passive: false } — React's
  // synthetic onWheel can't reliably preventDefault the page's own scroll
  // in every browser, which is what makes scroll-wheel interaction feel
  // broken (the page scrolls AND the canvas moves/zooms).
  //
  // Convention matches Figma/Miro rather than the "wheel always zooms"
  // behavior this started with: plain scrolling (a mouse wheel's vertical
  // delta, a trackpad's two-finger scroll on either axis, or shift+wheel
  // for horizontal on a plain mouse) PANS the board — which is what you
  // want on a canvas that can run long and wide. Zoom is reserved for
  // Ctrl/Cmd+scroll — which is also what a trackpad pinch-to-zoom gesture
  // reports as in the browser (ctrlKey is set automatically), so pinch
  // zoom keeps working without special-casing it. Zoom stays centered on
  // the cursor: the world point under the pointer stays under the pointer
  // after the scale change.
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
      // Shift turns a plain vertical wheel into horizontal scroll (the
      // standard convention on a mouse without a horizontal scroll wheel);
      // a trackpad instead reports its own deltaX directly.
      const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
      const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
      setView((prev) => ({ ...prev, pan: { x: prev.pan.x - dx, y: prev.pan.y - dy } }));
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // Depends on `board`, not []: the viewport div doesn't exist yet on the
    // very first render (this page shows a "Loading…" placeholder until
    // the board fetch resolves), so an effect that only ever ran once on
    // mount would find viewportRef.current still null and never attach at
    // all. Re-running once board goes from null to loaded (and again on
    // navigating to a different board) picks up the real element.
  }, [board]);

  function screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = viewportRef.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - pan.x) / scale, y: (clientY - rect.top - pan.y) / scale };
  }

  // ---- Pan / drag / resize gesture handling (pointer events, so mouse,
  // touch, and pen all share one code path) ----

  function handleBackgroundPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 && e.button !== 1) return;
    // Middle-click always pans, even over an item (handled here because
    // items stopPropagation on left-click only, not on button 1). A
    // left-click that reaches this handler at all means it landed on the
    // background itself, not an item. preventDefault on button 1 stops
    // the browser's own middle-click autoscroll indicator from popping up
    // and fighting with our own pan gesture.
    if (e.button === 1) e.preventDefault();
    setSelectedId(null);
    setSelectedConnectorId(null);
    setEditingId(null);
    gesture.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, startPan: pan };
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function handleItemDragStart(item: CanvasItem, e: React.PointerEvent) {
    if (e.button !== 0) return;
    gesture.current = { kind: 'drag', itemId: item.id, startX: e.clientX, startY: e.clientY, startItemX: item.x, startItemY: item.y };
    (e.target as Element).setPointerCapture(e.pointerId);
    e.stopPropagation();
  }

  function handleItemResizeStart(item: CanvasItem, e: React.PointerEvent) {
    gesture.current = { kind: 'resize', itemId: item.id, startX: e.clientX, startY: e.clientY, startWidth: item.width, startHeight: item.height };
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function handleConnectorHandleDown(item: CanvasItem, e: React.PointerEvent) {
    if (e.button !== 0) return;
    const start = { x: item.x + item.width / 2, y: item.y + item.height / 2 };
    gesture.current = { kind: 'connect', fromItemId: item.id, x: start.x, y: start.y };
    setConnectDraft({ fromItemId: item.id, ...start });
    // Capture on the viewport itself (not the handle) so the drag keeps
    // tracking even once the cursor moves off the small handle element —
    // handled in onPointerDown at the viewport level below via bubbling
    // isn't reliable once capture is set elsewhere, so we grab it here on
    // the nearest ancestor we know stays put for the whole gesture.
    viewportRef.current?.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent) {
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pan') {
      setView((prev) => ({ ...prev, pan: { x: g.startPan.x + (e.clientX - g.startX), y: g.startPan.y + (e.clientY - g.startY) } }));
    } else if (g.kind === 'drag') {
      const dx = (e.clientX - g.startX) / scale;
      const dy = (e.clientY - g.startY) / scale;
      setItems((prev) => (prev ? prev.map((it) => (it.id === g.itemId ? { ...it, x: g.startItemX + dx, y: g.startItemY + dy } : it)) : prev));
    } else if (g.kind === 'resize') {
      const dx = (e.clientX - g.startX) / scale;
      const dy = (e.clientY - g.startY) / scale;
      const width = Math.max(MIN_ITEM_SIZE, g.startWidth + dx);
      const height = Math.max(MIN_ITEM_SIZE, g.startHeight + dy);
      setItems((prev) => (prev ? prev.map((it) => (it.id === g.itemId ? { ...it, width, height } : it)) : prev));
    } else if (g.kind === 'connect') {
      const world = screenToWorld(e.clientX, e.clientY);
      gesture.current = { ...g, x: world.x, y: world.y };
      setConnectDraft({ fromItemId: g.fromItemId, x: world.x, y: world.y });
    }
  }

  function handlePointerUp() {
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.kind === 'pan') return;
    if (g.kind === 'connect') {
      setConnectDraft(null);
      // Drop target: the topmost item (by z-index) whose box contains the
      // release point, excluding the item the arrow started from — a
      // connector to itself isn't meaningful and the API rejects it too.
      const target = (items ?? [])
        .filter((it) => it.id !== g.fromItemId && rectContains(it, g.x, g.y))
        .sort((a, b) => b.z_index - a.z_index)[0];
      if (target) {
        api
          .createConnector(boardId, g.fromItemId, target.id)
          .then((connector) => setConnectors((prev) => [...prev, connector]))
          .catch(() => {
            // Already connected, or some other conflict — nothing to
            // recover here, the drag just doesn't produce a new arrow.
          });
      }
      return;
    }
    const item = items?.find((it) => it.id === g.itemId);
    if (!item) return;
    if (g.kind === 'drag') {
      api.updateBoardItem(item.id, { x: item.x, y: item.y });
    } else if (g.kind === 'resize') {
      api.updateBoardItem(item.id, { width: item.width, height: item.height });
    }
  }

  // ---- Item creation ----

  const nextZ = useCallback(() => (items && items.length > 0 ? Math.max(...items.map((it) => it.z_index)) + 1 : 0), [items]);

  function viewportCenterWorld(): { x: number; y: number } {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  async function createTextItem() {
    const center = viewportCenterWorld();
    const item = await api.createBoardItem(boardId, {
      type: 'text',
      x: center.x - DEFAULT_TEXT_SIZE.width / 2,
      y: center.y - DEFAULT_TEXT_SIZE.height / 2,
      ...DEFAULT_TEXT_SIZE,
      content: { text: '' },
    });
    setItems((prev) => [...(prev ?? []), item]);
    setSelectedId(item.id);
    setEditingId(item.id);
  }

  async function createNoteItem() {
    const center = viewportCenterWorld();
    const color = NOTE_COLORS[(items?.length ?? 0) % NOTE_COLORS.length];
    const item = await api.createBoardItem(boardId, {
      type: 'note',
      x: center.x - DEFAULT_NOTE_SIZE.width / 2,
      y: center.y - DEFAULT_NOTE_SIZE.height / 2,
      ...DEFAULT_NOTE_SIZE,
      content: { text: '', color },
    });
    setItems((prev) => [...(prev ?? []), item]);
    setSelectedId(item.id);
    setEditingId(item.id);
  }

  const uploadAt = useCallback(
    async (file: File, worldX: number, worldY: number) => {
      const [uploaded, size] = await Promise.all([api.uploadInline(file), computeItemSize(file)]);
      const item = await api.createBoardItem(boardId, {
        type: 'image',
        x: worldX - size.width / 2,
        y: worldY - size.height / 2,
        ...size,
        content: { r2_key: uploaded.r2_key, mime_type: uploaded.mime_type, filename: uploaded.filename },
      });
      setItems((prev) => [...(prev ?? []), item]);
    },
    [boardId]
  );

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDraggingOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;
    const drop = screenToWorld(e.clientX, e.clientY);
    // Multiple files dropped together fan out slightly instead of stacking
    // exactly on top of each other, so a multi-file drop is immediately
    // visible as separate items rather than looking like just one landed.
    files.forEach((file, i) => uploadAt(file, drop.x + i * 24, drop.y + i * 24));
  }

  // Paste-to-add covers the "clippings" use case — a screenshot copied to
  // the clipboard lands as an image item at the current viewport center,
  // no drag from a saved file required.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((it) => it.kind === 'file')
        .map((it) => it.getAsFile())
        .filter((f): f is File => f !== null);
      if (files.length === 0) return;
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      const { pan: p, scale: s } = viewRef.current;
      const center = { x: (rect.width / 2 - p.x) / s, y: (rect.height / 2 - p.y) / s };
      files.forEach((file, i) => uploadAt(file, center.x + i * 24, center.y + i * 24));
    }
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [uploadAt]);

  // ---- Editing / deleting ----

  function startEdit(item: CanvasItem) {
    setSelectedId(item.id);
    setEditingId(item.id);
  }

  function handleContentChange(item: CanvasItem, text: string) {
    setItems((prev) => (prev ? prev.map((it) => (it.id === item.id ? { ...it, content: JSON.stringify({ ...parseContent(it.content, {}), text }) } : it)) : prev));
    if (contentSaveTimer.current) clearTimeout(contentSaveTimer.current);
    contentSaveTimer.current = setTimeout(() => {
      const latest = items?.find((it) => it.id === item.id);
      const base = latest ? parseContent<Record<string, unknown>>(latest.content, {}) : {};
      api.updateBoardItem(item.id, { content: { ...base, text } });
    }, 500);
  }

  function stopEdit() {
    setEditingId(null);
  }

  async function deleteItem(item: CanvasItem) {
    setItems((prev) => (prev ? prev.filter((it) => it.id !== item.id) : prev));
    // The API cascades this server-side (DELETE /api/items/:id also drops
    // any connector touching it), but the client's already-loaded
    // `connectors` list won't reflect that on its own — prune it here too
    // so a dangling arrow doesn't linger until the next reload.
    setConnectors((prev) => prev.filter((c) => c.from_item_id !== item.id && c.to_item_id !== item.id));
    setSelectedId(null);
    await api.deleteBoardItem(item.id);
  }

  async function deleteConnector(connector: CanvasConnector) {
    setConnectors((prev) => prev.filter((c) => c.id !== connector.id));
    setSelectedConnectorId(null);
    await api.deleteConnector(connector.id);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (editingId) return; // let the textarea's own key handling own this
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedId) {
          const item = items?.find((it) => it.id === selectedId);
          if (item) deleteItem(item);
        } else if (selectedConnectorId) {
          const connector = connectors.find((c) => c.id === selectedConnectorId);
          if (connector) deleteConnector(connector);
        }
      } else if (e.key === 'Escape') {
        setSelectedId(null);
        setSelectedConnectorId(null);
        if (gesture.current?.kind === 'connect') {
          gesture.current = null;
          setConnectDraft(null);
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selectedConnectorId, editingId, items, connectors]);

  function selectItem(item: CanvasItem) {
    if (item.z_index < nextZ() - 1) {
      // Bring-to-front on select, so the item you're about to drag/resize
      // isn't hidden under something else the moment you touch it.
      const z = nextZ();
      setItems((prev) => (prev ? prev.map((it) => (it.id === item.id ? { ...it, z_index: z } : it)) : prev));
      api.updateBoardItem(item.id, { z_index: z });
    }
    setSelectedId(item.id);
    setSelectedConnectorId(null);
  }

  function selectConnector(connector: CanvasConnector) {
    setSelectedConnectorId(connector.id);
    setSelectedId(null);
  }

  // ---- Zoom controls ----

  function zoomBy(factor: number) {
    const rect = viewportRef.current?.getBoundingClientRect();
    const cx = rect ? rect.width / 2 : 0;
    const cy = rect ? rect.height / 2 : 0;
    setView(({ pan: prevPan, scale: prevScale }) => {
      const worldX = (cx - prevPan.x) / prevScale;
      const worldY = (cy - prevPan.y) / prevScale;
      const nextScale = clamp(prevScale * factor, MIN_SCALE, MAX_SCALE);
      return { scale: nextScale, pan: { x: cx - worldX * nextScale, y: cy - worldY * nextScale } };
    });
  }

  function resetZoom() {
    setView({ pan: { x: 0, y: 0 }, scale: 1 });
  }

  function fitToContent() {
    if (!items || items.length === 0 || !viewportRef.current) return resetZoom();
    const minX = Math.min(...items.map((it) => it.x));
    const minY = Math.min(...items.map((it) => it.y));
    const maxX = Math.max(...items.map((it) => it.x + it.width));
    const maxY = Math.max(...items.map((it) => it.y + it.height));
    const rect = viewportRef.current.getBoundingClientRect();
    const pad = 60;
    const nextScale = clamp(Math.min((rect.width - pad * 2) / (maxX - minX), (rect.height - pad * 2) / (maxY - minY)), MIN_SCALE, MAX_SCALE);
    setView({
      scale: nextScale,
      pan: { x: rect.width / 2 - ((minX + maxX) / 2) * nextScale, y: rect.height / 2 - ((minY + maxY) / 2) * nextScale },
    });
  }

  // ---- Title ----

  function handleTitleChange(value: string) {
    setTitleDraft(value);
    if (titleSaveTimer.current) clearTimeout(titleSaveTimer.current);
    titleSaveTimer.current = setTimeout(() => {
      api.renameBoard(boardId, value).then((b) => setBoard(b));
    }, 500);
  }

  if (error) return <div className="empty-state">Couldn't load this board: {error}</div>;
  if (!board || items === null) return <div className="empty-state">Loading…</div>;

  // See the long comment on the <svg> below for why this exists at all —
  // short version: the connector layer must be sized to real content
  // bounds, not 0 or some fixed number, on an unbounded canvas.
  const connectorPointsX = items.flatMap((it) => [it.x, it.x + it.width]);
  const connectorPointsY = items.flatMap((it) => [it.y, it.y + it.height]);
  if (connectDraft) {
    connectorPointsX.push(connectDraft.x);
    connectorPointsY.push(connectDraft.y);
  }
  const CONNECTOR_BOUNDS_PAD = 20; // room for stroke width + arrowhead at the extremes
  const connectorBounds =
    connectorPointsX.length > 0
      ? {
          minX: Math.min(...connectorPointsX) - CONNECTOR_BOUNDS_PAD,
          minY: Math.min(...connectorPointsY) - CONNECTOR_BOUNDS_PAD,
          maxX: Math.max(...connectorPointsX) + CONNECTOR_BOUNDS_PAD,
          maxY: Math.max(...connectorPointsY) + CONNECTOR_BOUNDS_PAD,
        }
      : { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  return (
    <div className="canvas-board">
      <div className="canvas-board__toolbar">
        <Link to="/boards" className="canvas-board__back" title="Back to Boards">
          ← Boards
        </Link>
        <input
          className="canvas-board__title-input"
          value={titleDraft}
          onChange={(e) => handleTitleChange(e.target.value)}
          placeholder="Untitled Board"
        />
        <div className="canvas-board__toolbar-actions">
          <button type="button" className="btn btn--ghost" onClick={createTextItem}>
            + Text
          </button>
          <button type="button" className="btn btn--ghost" onClick={createNoteItem}>
            + Note
          </button>
          <div className="canvas-board__zoom-group">
            <button type="button" className="canvas-board__zoom-btn" onClick={() => zoomBy(0.8)} title="Zoom out">
              −
            </button>
            <button type="button" className="canvas-board__zoom-pct" onClick={resetZoom} title="Reset to 100%">
              {Math.round(scale * 100)}%
            </button>
            <button type="button" className="canvas-board__zoom-btn" onClick={() => zoomBy(1.25)} title="Zoom in">
              +
            </button>
          </div>
          <button type="button" className="btn btn--ghost" onClick={fitToContent} disabled={items.length === 0}>
            Fit
          </button>
        </div>
      </div>

      <div
        ref={viewportRef}
        className={`canvas-board__viewport${isDraggingOver ? ' is-drag-over' : ''}`}
        onPointerDown={handleBackgroundPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDraggingOver(true);
        }}
        onDragLeave={() => setIsDraggingOver(false)}
        onDrop={handleDrop}
      >
        <div
          className="canvas-board__world"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
        >
          {/* Sized to the actual bounding box of everything it needs to
              draw (items + the in-progress draft line), not a fixed or
              zero size: a zero-size SVG with overflow:visible looks like
              it should paint its overflowing children anywhere, and does
              in isolation, but Chromium clips it to nothing once its
              ancestor (.canvas-board__world, which has will-change:
              transform for the pan/zoom GPU layer) gets promoted to its
              own compositor layer — a real quirk hit while building this,
              not a hypothetical. A fixed large size would dodge that too,
              but this is a genuinely unbounded canvas, so anything fixed
              is just a smaller version of the same bug waiting to happen
              once a board gets big enough. The inner <g> translates by
              -bounds so every line/marker below can keep using plain
              world-space coordinates, same as items' left/top. Sits first
              among the world div's children (and every item has z-index
              >= 0) so arrows stay behind cards without an explicit
              z-index dance. */}
          <svg
            className="canvas-board__connectors"
            style={{ position: 'absolute', left: connectorBounds.minX, top: connectorBounds.minY, width: connectorBounds.maxX - connectorBounds.minX, height: connectorBounds.maxY - connectorBounds.minY, overflow: 'visible' }}
          >
            <g transform={`translate(${-connectorBounds.minX}, ${-connectorBounds.minY})`}>
            <defs>
              <marker id="canvas-arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className="canvas-connector__arrowhead" />
              </marker>
              <marker id="canvas-arrowhead-selected" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className="canvas-connector__arrowhead canvas-connector__arrowhead--selected" />
              </marker>
            </defs>
            {connectors.map((connector) => {
              const from = items.find((it) => it.id === connector.from_item_id);
              const to = items.find((it) => it.id === connector.to_item_id);
              if (!from || !to) return null; // stale until the next load — deleteItem prunes these client-side
              const toCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
              const fromCenter = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
              const p1 = edgePointToward(from, toCenter.x, toCenter.y);
              const p2 = edgePointToward(to, fromCenter.x, fromCenter.y);
              const isSelected = selectedConnectorId === connector.id;
              return (
                <g key={connector.id}>
                  <line
                    x1={p1.x}
                    y1={p1.y}
                    x2={p2.x}
                    y2={p2.y}
                    className="canvas-connector__hit"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => selectConnector(connector)}
                  />
                  <line
                    x1={p1.x}
                    y1={p1.y}
                    x2={p2.x}
                    y2={p2.y}
                    className={`canvas-connector__line${isSelected ? ' is-selected' : ''}`}
                    markerEnd={`url(#canvas-arrowhead${isSelected ? '-selected' : ''})`}
                  />
                </g>
              );
            })}
            {connectDraft &&
              (() => {
                const from = items.find((it) => it.id === connectDraft.fromItemId);
                if (!from) return null;
                const p1 = edgePointToward(from, connectDraft.x, connectDraft.y);
                return <line x1={p1.x} y1={p1.y} x2={connectDraft.x} y2={connectDraft.y} className="canvas-connector__draft" />;
              })()}
            </g>
          </svg>

          {items.map((item) => (
            <CanvasItemView
              key={item.id}
              item={item}
              selected={selectedId === item.id}
              editing={editingId === item.id}
              onSelect={() => selectItem(item)}
              onDragStart={(e) => handleItemDragStart(item, e)}
              onResizeStart={(e) => handleItemResizeStart(item, e)}
              onStartEdit={() => startEdit(item)}
              onContentChange={(text) => handleContentChange(item, text)}
              onStopEdit={stopEdit}
              onDelete={() => deleteItem(item)}
              onConnectorHandleDown={(e) => handleConnectorHandleDown(item, e)}
            />
          ))}

          {selectedConnectorId &&
            (() => {
              const connector = connectors.find((c) => c.id === selectedConnectorId);
              const from = connector && items.find((it) => it.id === connector.from_item_id);
              const to = connector && items.find((it) => it.id === connector.to_item_id);
              if (!connector || !from || !to) return null;
              const mid = {
                x: (edgePointToward(from, to.x + to.width / 2, to.y + to.height / 2).x + edgePointToward(to, from.x + from.width / 2, from.y + from.height / 2).x) / 2,
                y: (edgePointToward(from, to.x + to.width / 2, to.y + to.height / 2).y + edgePointToward(to, from.x + from.width / 2, from.y + from.height / 2).y) / 2,
              };
              return (
                <button
                  type="button"
                  className="canvas-connector__delete"
                  style={{ left: mid.x, top: mid.y }}
                  title="Delete connector"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => deleteConnector(connector)}
                >
                  ✕
                </button>
              );
            })()}
        </div>

        {items.length === 0 && !isDraggingOver && (
          <div className="canvas-board__empty-hint">
            Drag photos or files in, paste a screenshot, or use + Text / + Note above to get started.
            <br />
            Scroll or middle-click-drag (or drag empty space) to pan, Ctrl/Cmd+scroll to zoom.
          </div>
        )}
        {isDraggingOver && <div className="canvas-board__drop-hint">Drop to add</div>}
      </div>
    </div>
  );
}

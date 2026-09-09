import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { CanvasBoard, CanvasItem, ConnectorItemContent, ImageItemContent, NoteItemContent, TextItemContent } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

function itemCenter(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Where a straight line from a rect's center toward some other point
 * exits the rect's boundary — i.e. a good "arrow starts/ends at the edge
 * of the card, not floating in its middle" anchor point. Standard ray/box
 * intersection: scale the center-to-target vector down by whichever axis
 * hits its half-extent first. */
function edgePointToward(rect: Rect, towardX: number, towardY: number): Point {
  const { x: cx, y: cy } = itemCenter(rect);
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

const DEFAULT_CONNECTOR_CONTENT: ConnectorItemContent = { style: 'arrow', fromItemId: null, x1: 0, y1: 0, toItemId: null, x2: 100, y2: 0 };

/** Resolves a connector item's two actual endpoints in world space. An
 * attached endpoint (fromItemId/toItemId set) is recomputed from that
 * item's live box every call — the same edge-of-the-card anchoring as the
 * old item-to-item connector model, just per-endpoint instead of forced
 * on both ends. `live` overrides one endpoint with an in-progress drag
 * position (and treats it as temporarily detached, so the preview line
 * doesn't jump back to the card while you're still dragging away from
 * it). */
function connectorEndpoints(
  item: CanvasItem,
  itemsById: Map<string, CanvasItem>,
  live?: { end: 'from' | 'to'; x: number; y: number }
): { p1: Point; p2: Point } {
  const meta = parseContent<ConnectorItemContent>(item.content, DEFAULT_CONNECTOR_CONTENT);
  const raw1 = live?.end === 'from' ? { x: live.x, y: live.y } : { x: meta.x1, y: meta.y1 };
  const raw2 = live?.end === 'to' ? { x: live.x, y: live.y } : { x: meta.x2, y: meta.y2 };
  const fromItem = meta.fromItemId && live?.end !== 'from' ? itemsById.get(meta.fromItemId) : undefined;
  const toItem = meta.toItemId && live?.end !== 'to' ? itemsById.get(meta.toItemId) : undefined;
  const p2Ref = toItem ? itemCenter(toItem) : raw2;
  const p1Ref = fromItem ? itemCenter(fromItem) : raw1;
  const p1 = fromItem ? edgePointToward(fromItem, p2Ref.x, p2Ref.y) : raw1;
  const p2 = toItem ? edgePointToward(toItem, p1Ref.x, p1Ref.y) : raw2;
  return { p1, p2 };
}

/** A non-connector item's box, or a connector item's bounding box derived
 * from its resolved endpoints — the common shape fitToContent and the
 * connector SVG layer both need, so callers don't have to special-case
 * connector items themselves. */
function itemWorldBounds(item: CanvasItem, itemsById: Map<string, CanvasItem>): Rect {
  if (item.type !== 'connector') return { x: item.x, y: item.y, width: item.width, height: item.height };
  const { p1, p2 } = connectorEndpoints(item, itemsById);
  const minX = Math.min(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  return { x: minX, y: minY, width: Math.max(1, Math.abs(p2.x - p1.x)), height: Math.max(1, Math.abs(p2.y - p1.y)) };
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
const DEFAULT_CONNECTOR_LENGTH = 180;
// How far back from (0,0) a board's content is allowed to start — see the
// top-left-anchoring comment on the page component below. 0 would flush
// new items right against the boundary; a little breathing room reads
// better.
const NORMALIZE_PAD = 24;

const NOTE_COLORS = ['#F6DE7C', '#B9DDC7', '#F3C6C6', '#C9D9F3'];

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

interface Pan {
  x: number;
  y: number;
}

/** A board's top-left corner (world 0,0) is a hard boundary, not just a
 * starting point — see the page component's top comment for why. Any pan
 * value the app produces (from a drag, a wheel event, a zoom button, fit-
 * to-content, whatever) gets funneled through this before it's applied. */
function clampPan(pan: Pan): Pan {
  return { x: Math.min(0, pan.x), y: Math.min(0, pan.y) };
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
 * be selected or edited at a time.
 *
 * Never used for a 'connector' item — those have no box to speak of and
 * render as lines in the SVG layer instead (see CanvasBoardPage). */
function CanvasItemView({
  item,
  selected,
  editing,
  editingTitle,
  onSelect,
  onDragStart,
  onResizeStart,
  onStartEdit,
  onContentChange,
  onStopEdit,
  onDelete,
  onStartTitleEdit,
  onTitleChange,
  onStopTitleEdit,
}: {
  item: CanvasItem;
  selected: boolean;
  editing: boolean;
  editingTitle: boolean;
  onSelect: (e: React.PointerEvent) => void;
  onDragStart: (e: React.PointerEvent) => void;
  onResizeStart: (e: React.PointerEvent) => void;
  onStartEdit: () => void;
  onContentChange: (text: string) => void;
  onStopEdit: () => void;
  onDelete: () => void;
  onStartTitleEdit: () => void;
  onTitleChange: (title: string) => void;
  onStopTitleEdit: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    if (editingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [editingTitle]);

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
      onDoubleClick={(e) => {
        e.stopPropagation(); // don't also trigger the background's double-click-to-fit
        if (item.type !== 'image') onStartEdit();
      }}
    >
      {body}
      {/* The title label floats above the box (negative top, inside this
          already-position:absolute div) rather than eating into it, so it
          never competes with the item's own content for space. Static
          text when there's a title and the item isn't selected; an input
          once selected, whether or not there's a title yet to edit. */}
      {selected && !editing ? (
        <input
          ref={titleInputRef}
          className="canvas-item__title-input"
          value={item.title ?? ''}
          placeholder="Add a title…"
          onChange={(e) => onTitleChange(e.target.value)}
          onFocus={onStartTitleEdit}
          onBlur={onStopTitleEdit}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Escape' || e.key === 'Enter') e.currentTarget.blur();
            e.stopPropagation();
          }}
        />
      ) : (
        item.title && <div className="canvas-item__title-label">{item.title}</div>
      )}
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
        </>
      )}
    </div>
  );
}

/** The infinite canvas itself — a spatial pinboard distinct from every
 * other document-shaped view in this app.
 *
 * World-space coordinates live on items (x/y/width/height); the viewport
 * is just a pan offset + zoom scale applied as a single CSS transform on
 * the .canvas-board__world wrapper, so panning/zooming is one GPU-
 * accelerated transform rather than recomputing every item's screen
 * position on every frame — this is what keeps it responsive with a lot
 * of items.
 *
 * Unlike the first version of this feature, the plane is NOT unbounded in
 * every direction: (0,0) is a fixed top-left corner, and content can only
 * grow right/down from there (clampPan below enforces this on every pan
 * source — drag, wheel, zoom buttons, fit-to-content). An infinite canvas
 * that can be panned into arbitrarily-negative space made it too easy to
 * scroll away from your own content and not know which direction to go
 * back — anchoring one corner gives panning an orientation. `load()`
 * below also normalizes any item left over from before this change (or
 * from a bug) with negative coordinates, shifting everything on that
 * board back into positive space once, the first time it's opened.
 *
 * Connector items ('arrow'/'line' via ConnectorItemContent) are
 * freestanding — the toolbar's + Arrow / + Divider tools drop one
 * anywhere, and it does NOT have to touch a card at all. Dragging either
 * endpoint onto a card "snaps" that end to it (auto-follows from then on,
 * same edge-anchoring idea as v1's connectors); dragging it back onto
 * empty canvas un-snaps it. This replaced the original "every card has
 * connector handles on its edges" model per Mike's feedback that he
 * didn't want every element originating an arrow. */
export function CanvasBoardPage() {
  const { id } = useParams<{ id: string }>();
  const boardId = id!;
  const navigate = useNavigate();

  const [board, setBoard] = useState<CanvasBoard | null>(null);
  const [items, setItems] = useState<CanvasItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  // Live position of an in-progress "drag this connector's endpoint"
  // gesture, in world coordinates — drives both the live preview line and
  // (via connectorEndpoints' `live` param) suppresses snapping to the
  // attached card while you're actively dragging away from it. Kept in
  // React state (unlike the gesture ref below) because it needs to
  // trigger a re-render every pointermove to actually be visible.
  const [endpointDraft, setEndpointDraft] = useState<{ itemId: string; end: 'from' | 'to'; x: number; y: number } | null>(null);
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
    | { kind: 'connector-endpoint'; itemId: string; end: 'from' | 'to'; x: number; y: number }
    | { kind: 'connector-move'; itemId: string; startX: number; startY: number; startX1: number; startY1: number; startX2: number; startY2: number }
    | null
  >(null);

  useReportTabMeta(board?.title || 'Board', 'board');

  const load = useCallback(() => {
    api
      .getBoard(boardId)
      .then((res) => {
        setBoard(res.board);
        setTitleDraft(res.board.title);
        // One-time normalization for a board with any negative-coordinate
        // item (left over from before top-left anchoring existed, or a
        // connector detached to a point off in negative space): shift
        // everything so the whole board starts at/after (0,0). Connector
        // items keep up automatically since their attached endpoints
        // recompute from the shifted card; freestanding endpoints are
        // shifted by the same amount as their explicit x1/y1/x2/y2.
        const minX = res.items.length > 0 ? Math.min(...res.items.map((it) => it.x)) : 0;
        const minY = res.items.length > 0 ? Math.min(...res.items.map((it) => it.y)) : 0;
        if (minX < 0 || minY < 0) {
          const dx = minX < 0 ? -minX + NORMALIZE_PAD : 0;
          const dy = minY < 0 ? -minY + NORMALIZE_PAD : 0;
          const shifted = res.items.map((it) => {
            if (it.type !== 'connector') return { ...it, x: it.x + dx, y: it.y + dy };
            const meta = parseContent<ConnectorItemContent>(it.content, DEFAULT_CONNECTOR_CONTENT);
            const nextMeta: ConnectorItemContent = { ...meta, x1: meta.x1 + dx, y1: meta.y1 + dy, x2: meta.x2 + dx, y2: meta.y2 + dy };
            return { ...it, x: it.x + dx, y: it.y + dy, content: JSON.stringify(nextMeta) };
          });
          setItems(shifted);
          shifted.forEach((it) => {
            const patch = it.type === 'connector' ? { x: it.x, y: it.y, content: parseContent<ConnectorItemContent>(it.content, DEFAULT_CONNECTOR_CONTENT) } : { x: it.x, y: it.y };
            api.updateBoardItem(it.id, patch);
          });
        } else {
          setItems(res.items);
        }
      })
      .catch((e) => setError(String(e)));
  }, [boardId]);

  useEffect(() => {
    load();
    setSelectedId(null);
    setEditingId(null);
    setEditingTitleId(null);
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
          return { scale: nextScale, pan: clampPan({ x: cursorX - worldX * nextScale, y: cursorY - worldY * nextScale }) };
        });
        return;
      }
      // Shift turns a plain vertical wheel into horizontal scroll (the
      // standard convention on a mouse without a horizontal scroll wheel);
      // a trackpad instead reports its own deltaX directly.
      const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
      const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
      setView((prev) => ({ ...prev, pan: clampPan({ x: prev.pan.x - dx, y: prev.pan.y - dy }) }));
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

  function screenToWorld(clientX: number, clientY: number): Point {
    const rect = viewportRef.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - pan.x) / scale, y: (clientY - rect.top - pan.y) / scale };
  }

  // ---- Pan / drag / resize / connector gesture handling (pointer events,
  // so mouse, touch, and pen all share one code path) ----

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
    setEditingId(null);
    setEditingTitleId(null);
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

  function handleConnectorEndpointDown(item: CanvasItem, end: 'from' | 'to', point: Point, e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    gesture.current = { kind: 'connector-endpoint', itemId: item.id, end, ...point };
    setEndpointDraft({ itemId: item.id, end, ...point });
    viewportRef.current?.setPointerCapture(e.pointerId);
  }

  // Grabbing the line itself (not an endpoint handle) moves the whole
  // connector — the "drag a divider to a different part of the board"
  // Mike asked for. p1/p2 are the endpoints' already-resolved live
  // positions (not the raw stored x1/y1/x2/y2, which can be stale for an
  // attached end) so the drag starts from where the line actually is.
  // Moving it detaches both ends: a connector you're relocating by its
  // body isn't meant to stay pinned to whatever card it used to touch.
  function handleConnectorMoveStart(item: CanvasItem, p1: Point, p2: Point, e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    selectItem(item);
    gesture.current = { kind: 'connector-move', itemId: item.id, startX: e.clientX, startY: e.clientY, startX1: p1.x, startY1: p1.y, startX2: p2.x, startY2: p2.y };
    viewportRef.current?.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent) {
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pan') {
      setView((prev) => ({ ...prev, pan: clampPan({ x: g.startPan.x + (e.clientX - g.startX), y: g.startPan.y + (e.clientY - g.startY) }) }));
    } else if (g.kind === 'drag') {
      const dx = (e.clientX - g.startX) / scale;
      const dy = (e.clientY - g.startY) / scale;
      const x = Math.max(0, g.startItemX + dx);
      const y = Math.max(0, g.startItemY + dy);
      setItems((prev) => (prev ? prev.map((it) => (it.id === g.itemId ? { ...it, x, y } : it)) : prev));
    } else if (g.kind === 'resize') {
      const dx = (e.clientX - g.startX) / scale;
      const dy = (e.clientY - g.startY) / scale;
      const width = Math.max(MIN_ITEM_SIZE, g.startWidth + dx);
      const height = Math.max(MIN_ITEM_SIZE, g.startHeight + dy);
      setItems((prev) => (prev ? prev.map((it) => (it.id === g.itemId ? { ...it, width, height } : it)) : prev));
    } else if (g.kind === 'connector-endpoint') {
      const world = screenToWorld(e.clientX, e.clientY);
      gesture.current = { ...g, x: world.x, y: world.y };
      setEndpointDraft({ itemId: g.itemId, end: g.end, x: world.x, y: world.y });
    } else if (g.kind === 'connector-move') {
      const dx = (e.clientX - g.startX) / scale;
      const dy = (e.clientY - g.startY) / scale;
      const x1 = g.startX1 + dx;
      const y1 = g.startY1 + dy;
      const x2 = g.startX2 + dx;
      const y2 = g.startY2 + dy;
      setItems((prev) =>
        prev
          ? prev.map((it) => {
              if (it.id !== g.itemId) return it;
              const meta = parseContent<ConnectorItemContent>(it.content, DEFAULT_CONNECTOR_CONTENT);
              const nextMeta: ConnectorItemContent = { ...meta, fromItemId: null, toItemId: null, x1, y1, x2, y2 };
              return { ...it, content: JSON.stringify(nextMeta) };
            })
          : prev
      );
    }
  }

  function handlePointerUp() {
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.kind === 'pan') return;
    if (g.kind === 'connector-endpoint') {
      setEndpointDraft(null);
      const connectorItem = items?.find((it) => it.id === g.itemId);
      if (!connectorItem) return;
      const meta = parseContent<ConnectorItemContent>(connectorItem.content, DEFAULT_CONNECTOR_CONTENT);
      // Snap target: the topmost OTHER non-connector item whose box
      // contains the release point (you can't attach an arrow to another
      // arrow). No target = this endpoint is (or stays) freestanding.
      const target = (items ?? [])
        .filter((it) => it.id !== g.itemId && it.type !== 'connector' && rectContains(it, g.x, g.y))
        .sort((a, b) => b.z_index - a.z_index)[0];
      const nextMeta: ConnectorItemContent =
        g.end === 'from'
          ? { ...meta, fromItemId: target?.id ?? null, x1: g.x, y1: g.y }
          : { ...meta, toItemId: target?.id ?? null, x2: g.x, y2: g.y };
      setItems((prev) => (prev ? prev.map((it) => (it.id === g.itemId ? { ...it, content: JSON.stringify(nextMeta) } : it)) : prev));
      api.updateBoardItem(g.itemId, { content: nextMeta });
      return;
    }
    if (g.kind === 'connector-move') {
      const connectorItem = items?.find((it) => it.id === g.itemId);
      if (!connectorItem) return;
      api.updateBoardItem(g.itemId, { content: parseContent<ConnectorItemContent>(connectorItem.content, DEFAULT_CONNECTOR_CONTENT) });
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

  function viewportCenterWorld(): Point {
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

  async function createConnectorItem(style: 'arrow' | 'line') {
    const center = viewportCenterWorld();
    const half = DEFAULT_CONNECTOR_LENGTH / 2;
    const content: ConnectorItemContent = { style, fromItemId: null, x1: center.x - half, y1: center.y, toItemId: null, x2: center.x + half, y2: center.y };
    const item = await api.createBoardItem(boardId, {
      type: 'connector',
      x: center.x - half,
      y: center.y,
      width: DEFAULT_CONNECTOR_LENGTH,
      height: 1,
      content,
    });
    setItems((prev) => [...(prev ?? []), item]);
    setSelectedId(item.id);
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

  function handleTitleFieldChange(item: CanvasItem, title: string) {
    setItems((prev) => (prev ? prev.map((it) => (it.id === item.id ? { ...it, title } : it)) : prev));
  }

  function stopTitleEdit(item: CanvasItem) {
    setEditingTitleId(null);
    const latest = items?.find((it) => it.id === item.id);
    api.updateBoardItem(item.id, { title: latest?.title?.trim() || null });
  }

  async function deleteItem(item: CanvasItem) {
    // A connector attached to the item being deleted doesn't disappear
    // with it — it detaches, freezing at its last resolved position, so
    // deleting a card doesn't silently destroy arrows you drew around it.
    const itemsById = new Map((items ?? []).map((it) => [it.id, it]));
    const detachPatches = (items ?? [])
      .filter((it) => it.type === 'connector' && it.id !== item.id)
      .map((connector) => {
        const meta = parseContent<ConnectorItemContent>(connector.content, DEFAULT_CONNECTOR_CONTENT);
        if (meta.fromItemId !== item.id && meta.toItemId !== item.id) return null;
        const { p1, p2 } = connectorEndpoints(connector, itemsById);
        const nextMeta: ConnectorItemContent = { ...meta };
        if (meta.fromItemId === item.id) {
          nextMeta.fromItemId = null;
          nextMeta.x1 = p1.x;
          nextMeta.y1 = p1.y;
        }
        if (meta.toItemId === item.id) {
          nextMeta.toItemId = null;
          nextMeta.x2 = p2.x;
          nextMeta.y2 = p2.y;
        }
        return { id: connector.id, content: nextMeta };
      })
      .filter((p): p is { id: string; content: ConnectorItemContent } => p !== null);

    setItems((prev) =>
      prev
        ? prev
            .filter((it) => it.id !== item.id)
            .map((it) => {
              const patch = detachPatches.find((p) => p.id === it.id);
              return patch ? { ...it, content: JSON.stringify(patch.content) } : it;
            })
        : prev
    );
    setSelectedId(null);
    await api.deleteBoardItem(item.id);
    await Promise.all(detachPatches.map((p) => api.updateBoardItem(p.id, { content: p.content })));
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (editingId || editingTitleId) return; // let the input/textarea's own key handling own this
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        const item = items?.find((it) => it.id === selectedId);
        if (item) deleteItem(item);
      } else if (e.key === 'Escape') {
        setSelectedId(null);
        if (gesture.current?.kind === 'connector-endpoint') {
          gesture.current = null;
          setEndpointDraft(null);
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, editingId, editingTitleId, items]);

  function selectItem(item: CanvasItem) {
    if (item.z_index < nextZ() - 1) {
      // Bring-to-front on select, so the item you're about to drag/resize
      // isn't hidden under something else the moment you touch it.
      const z = nextZ();
      setItems((prev) => (prev ? prev.map((it) => (it.id === item.id ? { ...it, z_index: z } : it)) : prev));
      api.updateBoardItem(item.id, { z_index: z });
    }
    setSelectedId(item.id);
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
      return { scale: nextScale, pan: clampPan({ x: cx - worldX * nextScale, y: cy - worldY * nextScale }) };
    });
  }

  function resetZoom() {
    setView({ pan: { x: 0, y: 0 }, scale: 1 });
  }

  function fitToContent() {
    if (!items || items.length === 0 || !viewportRef.current) return resetZoom();
    const itemsById = new Map(items.map((it) => [it.id, it]));
    const bounds = items.map((it) => itemWorldBounds(it, itemsById));
    const minX = Math.min(...bounds.map((b) => b.x));
    const minY = Math.min(...bounds.map((b) => b.y));
    const maxX = Math.max(...bounds.map((b) => b.x + b.width));
    const maxY = Math.max(...bounds.map((b) => b.y + b.height));
    const rect = viewportRef.current.getBoundingClientRect();
    const pad = 60;
    const nextScale = clamp(Math.min((rect.width - pad * 2) / (maxX - minX), (rect.height - pad * 2) / (maxY - minY)), MIN_SCALE, MAX_SCALE);
    setView({
      scale: nextScale,
      pan: clampPan({ x: rect.width / 2 - ((minX + maxX) / 2) * nextScale, y: rect.height / 2 - ((minY + maxY) / 2) * nextScale }),
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

  const itemsById = new Map(items.map((it) => [it.id, it]));
  const connectorItems = items.filter((it) => it.type === 'connector');
  const boxItems = items.filter((it) => it.type !== 'connector');
  const selectedConnector = selectedId ? connectorItems.find((it) => it.id === selectedId) : undefined;

  // See the long comment on the <svg> below for why this exists at all —
  // short version: the connector layer must be sized to real content
  // bounds, not 0 or some fixed number.
  const connectorPointsX: number[] = [];
  const connectorPointsY: number[] = [];
  connectorItems.forEach((ci) => {
    const live = endpointDraft && endpointDraft.itemId === ci.id ? endpointDraft : undefined;
    const { p1, p2 } = connectorEndpoints(ci, itemsById, live);
    connectorPointsX.push(p1.x, p2.x);
    connectorPointsY.push(p1.y, p2.y);
  });
  const CONNECTOR_BOUNDS_PAD = 20; // room for stroke width + arrowhead + endpoint handles at the extremes
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
        {/* Same back-chip + link chrome as Projects/Today-Week (see
            Breadcrumb.tsx and .breadcrumb__back) instead of this page's
            own plain text link, so the back control feels consistent
            everywhere in the app. No trailing "current" segment needed
            here — the editable title input right next to it already
            shows/edits the board's name. */}
        <div className="breadcrumb canvas-board__breadcrumb">
          <button type="button" className="breadcrumb__back" onClick={() => navigate('/boards')} title="Back to Boards" aria-label="Back to Boards">
            ‹
          </button>
          <Link to="/boards" className="breadcrumb__link">
            Boards
          </Link>
        </div>
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
          <button type="button" className="btn btn--ghost" onClick={() => createConnectorItem('arrow')} title="Add a freestanding arrow">
            + Arrow
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => createConnectorItem('line')} title="Add a divider line">
            + Divider
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
          <button type="button" className="btn btn--ghost" onClick={fitToContent} disabled={items.length === 0} title="Fit all content in view">
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
        onDoubleClick={() => fitToContent()}
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
              draw (connector endpoints + the in-progress drag), not a
              fixed or zero size: a zero-size SVG with overflow:visible
              looks like it should paint its overflowing children
              anywhere, and does in isolation, but Chromium clips it to
              nothing once its ancestor (.canvas-board__world, which has
              will-change: transform for the pan/zoom GPU layer) gets
              promoted to its own compositor layer — a real quirk hit
              while building this, not a hypothetical. A fixed large size
              would dodge that too, but this is a genuinely large canvas,
              so anything fixed is just a smaller version of the same bug
              waiting to happen. The inner <g> translates by -bounds so
              every line/marker below can keep using plain world-space
              coordinates, same as items' left/top. Sits first among the
              world div's children so connector lines stay behind every
              card regardless of the connector's own z-index — connectors
              are meant to read as background relationships/dividers, not
              things that cover up cards. */}
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
              {connectorItems.map((connectorItem) => {
                const meta = parseContent<ConnectorItemContent>(connectorItem.content, DEFAULT_CONNECTOR_CONTENT);
                const live = endpointDraft && endpointDraft.itemId === connectorItem.id ? endpointDraft : undefined;
                const { p1, p2 } = connectorEndpoints(connectorItem, itemsById, live);
                const isSelected = selectedId === connectorItem.id;
                return (
                  <g key={connectorItem.id}>
                    <line
                      x1={p1.x}
                      y1={p1.y}
                      x2={p2.x}
                      y2={p2.y}
                      className="canvas-connector__hit"
                      onPointerDown={(e) => handleConnectorMoveStart(connectorItem, p1, p2, e)}
                    />
                    <line
                      x1={p1.x}
                      y1={p1.y}
                      x2={p2.x}
                      y2={p2.y}
                      className={`canvas-connector__line canvas-connector__line--${meta.style}${isSelected ? ' is-selected' : ''}`}
                      markerEnd={meta.style === 'arrow' ? `url(#canvas-arrowhead${isSelected ? '-selected' : ''})` : undefined}
                    />
                  </g>
                );
              })}
            </g>
          </svg>

          {boxItems.map((item) => (
            <CanvasItemView
              key={item.id}
              item={item}
              selected={selectedId === item.id}
              editing={editingId === item.id}
              editingTitle={editingTitleId === item.id}
              onSelect={() => selectItem(item)}
              onDragStart={(e) => handleItemDragStart(item, e)}
              onResizeStart={(e) => handleItemResizeStart(item, e)}
              onStartEdit={() => startEdit(item)}
              onContentChange={(text) => handleContentChange(item, text)}
              onStopEdit={stopEdit}
              onDelete={() => deleteItem(item)}
              onStartTitleEdit={() => setEditingTitleId(item.id)}
              onTitleChange={(title) => handleTitleFieldChange(item, title)}
              onStopTitleEdit={() => stopTitleEdit(item)}
            />
          ))}

          {selectedConnector &&
            (() => {
              const live = endpointDraft && endpointDraft.itemId === selectedConnector.id ? endpointDraft : undefined;
              const { p1, p2 } = connectorEndpoints(selectedConnector, itemsById, live);
              const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
              return (
                <>
                  <div
                    className="canvas-connector__endpoint-handle"
                    style={{ left: p1.x, top: p1.y }}
                    onPointerDown={(e) => handleConnectorEndpointDown(selectedConnector, 'from', p1, e)}
                  />
                  <div
                    className="canvas-connector__endpoint-handle"
                    style={{ left: p2.x, top: p2.y }}
                    onPointerDown={(e) => handleConnectorEndpointDown(selectedConnector, 'to', p2, e)}
                  />
                  <button
                    type="button"
                    className="canvas-connector__delete"
                    style={{ left: mid.x, top: mid.y }}
                    title="Delete"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => deleteItem(selectedConnector)}
                  >
                    ✕
                  </button>
                </>
              );
            })()}
        </div>

        {items.length === 0 && !isDraggingOver && (
          <div className="canvas-board__empty-hint">
            Drag photos or files in, paste a screenshot, or use the toolbar above to get started.
            <br />
            Scroll or middle-click-drag (or drag empty space) to pan, Ctrl/Cmd+scroll to zoom, double-click to fit.
          </div>
        )}
        {isDraggingOver && <div className="canvas-board__drop-hint">Drop to add</div>}
      </div>
    </div>
  );
}

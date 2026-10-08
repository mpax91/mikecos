import type { Entity } from '../api/types';

/** App-wide "a task was just checked off" signal. api.updateEntity emits it
 * whenever a PATCH sets a task's status to 'done' (every completion path —
 * TaskRow, Today, the task panel — goes through that one call), and the
 * Waiting For toast (FollowUpToast) listens. */
const EVENT = 'mikeos:task-completed';

export function emitTaskCompleted(task: Entity) {
  window.dispatchEvent(new CustomEvent<Entity>(EVENT, { detail: task }));
}

export function onTaskCompleted(fn: (task: Entity) => void): () => void {
  const handler = (e: Event) => fn((e as CustomEvent<Entity>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

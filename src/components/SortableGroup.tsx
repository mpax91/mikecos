import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import type { Entity } from '../api/types';
import { EntityRow } from './EntityRow';

export function SortableGroup({
  items,
  onReorder,
  onToggleTask,
}: {
  items: Entity[];
  onReorder: (ordered: Entity[]) => void;
  onToggleTask?: (entity: Entity) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((i) => i.id === active.id);
    const newIndex = items.findIndex((i) => i.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    onReorder(arrayMove(items, oldIndex, newIndex));
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        {items.map((entity) => (
          <EntityRow key={entity.id} entity={entity} onToggleTask={onToggleTask} />
        ))}
      </SortableContext>
    </DndContext>
  );
}

import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';

export function SortableGrid<T extends { id: string }>({
  items,
  onReorder,
  renderItem,
  className,
  layout = 'grid',
}: {
  items: T[];
  onReorder: (ordered: T[]) => void;
  renderItem: (item: T) => React.ReactNode;
  className?: string;
  layout?: 'grid' | 'list';
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
      <SortableContext
        items={items.map((i) => i.id)}
        strategy={layout === 'list' ? verticalListSortingStrategy : rectSortingStrategy}
      >
        <div className={className}>{items.map((item) => renderItem(item))}</div>
      </SortableContext>
    </DndContext>
  );
}

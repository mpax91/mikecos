import type { ReactNode } from 'react';

export function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <div className="detail-section">
      <div className="detail-section__header">{title}</div>
      {children}
    </div>
  );
}

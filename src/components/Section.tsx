import type { ReactNode } from 'react';

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="detail-section">
      <div className="detail-section__header">{title}</div>
      {children}
    </div>
  );
}

import { useState } from 'react';
import type { ReactNode } from 'react';

function ChevronIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M4 3l6 5-6 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="detail-section">
      <div
        className="detail-section__header"
        onClick={() => setExpanded((v) => !v)}
        role="button"
        tabIndex={0}
      >
        <span className={`detail-section__chevron${expanded ? ' is-expanded' : ''}`}>
          <ChevronIcon />
        </span>
        {title}
      </div>
      {expanded && children}
    </div>
  );
}

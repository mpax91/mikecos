interface TabBarProps {
  onMenuClick?: () => void;
}

export function TabBar({ onMenuClick }: TabBarProps) {
  return (
    <div className="tabbar">
      <button className="tabbar__menu-btn" onClick={onMenuClick} aria-label="Open menu" title="Open menu">
        ☰
      </button>
      <div className="tabbar__tab title-case">Projects</div>
      <div className="tabbar__new" title="New tab — coming later">
        +
      </div>
    </div>
  );
}

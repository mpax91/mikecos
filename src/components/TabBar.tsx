import { useTabs, tabIcon, type Tab } from '../contexts/TabsContext';
import type { ContextMenuItem } from './ContextMenu';

interface TabBarProps {
  onMenuClick?: () => void;
}

/** Desktop browser-style tab strip: one tab per open item, pinned tabs
 * (icon-only) first, then unpinned tabs (icon + title + close). Mobile
 * keeps the app's original hamburger-only header — see the CSS, which hides
 * the tab strip itself below the phone breakpoint. */
export function TabBar({ onMenuClick }: TabBarProps) {
  const { tabs, activeTabId, switchTab, closeTab, openTab, pinTab, unpinTab, showContextMenu } = useTabs();

  function handleContextMenu(e: React.MouseEvent, tab: Tab) {
    e.preventDefault();
    const items: ContextMenuItem[] = [
      tab.pinned
        ? { label: 'Unpin Tab', onClick: () => unpinTab(tab.id) }
        : { label: 'Pin Tab', onClick: () => pinTab(tab.id) },
    ];
    items.push({ label: 'Close Tab', onClick: () => closeTab(tab.id), separatorBefore: true });
    showContextMenu(e.clientX, e.clientY, items);
  }

  return (
    <div className="tabbar">
      <button className="tabbar__menu-btn" onClick={onMenuClick} aria-label="Open menu" title="Open menu">
        ☰
      </button>
      <div className="tabbar__tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tabbar__tab${tab.id === activeTabId ? ' is-active' : ''}${tab.pinned ? ' is-pinned' : ''}`}
            onClick={() => switchTab(tab.id)}
            onContextMenu={(e) => handleContextMenu(e, tab)}
            title={tab.title}
          >
            <span className="tabbar__tab-icon">{tabIcon(tab.kind)}</span>
            {!tab.pinned && <span className="tabbar__tab-title">{tab.title}</span>}
            {!tab.pinned && (
              <button
                type="button"
                className="tabbar__tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                aria-label={`Close ${tab.title}`}
                title="Close tab"
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
      <button className="tabbar__new" title="New tab" onClick={() => openTab('/projects')}>
        +
      </button>
    </div>
  );
}

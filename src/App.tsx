import { useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { TodayPage } from './pages/TodayPage';
import { WeekPage } from './pages/WeekPage';
import { MonthPage } from './pages/MonthPage';
import { ProjectsList } from './pages/ProjectsList';
import { ProjectDetail } from './pages/ProjectDetail';
import { NotesPage } from './pages/NotesPage';
import { JotsPage } from './pages/JotsPage';
import { StatsPage } from './pages/StatsPage';
import { SettingsPage } from './pages/SettingsPage';
import { BoardsListPage } from './pages/BoardsListPage';
import { CanvasBoardPage } from './pages/CanvasBoardPage';
import { ContactsListPage } from './pages/ContactsListPage';
import { ContactDetailPage } from './pages/ContactDetailPage';
import { JournalPage } from './pages/JournalPage';
import { DashboardPage } from './pages/DashboardPage';
import { BetsPage } from './pages/BetsPage';
import { NewsPage } from './pages/NewsPage';
import { LinksPage } from './pages/LinksPage';
import { VaultPage } from './pages/VaultPage';
import { VaultRollupsPage } from './pages/VaultRollupsPage';
import { WalletPage } from './pages/WalletPage';
import { PlexPage } from './pages/PlexPage';
import { ListsPage } from './pages/ListsPage';
import { ListDetail } from './pages/ListDetail';
import { SearchPalette } from './components/SearchPalette';
import { BriefingModal } from './components/BriefingModal';
import { LockScreen } from './components/LockScreen';
import { useAuth } from './contexts/AuthContext';

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { phase } = useAuth();

  // Nothing behind the lock screen ever mounts — no sidebar, no routes, no
  // data fetches — until there's a valid session (or, on very first run,
  // until a login method has been set up at all). "Locked" and "setup" are
  // deliberately kept as separate states in AuthContext but share the same
  // full-screen treatment here.
  if (phase === 'loading') return null;
  if (phase === 'setup' || phase === 'locked') return <LockScreen phase={phase} />;

  return (
    <div className="app-shell">
      <SearchPalette />
      <BriefingModal />
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="main">
        <TabBar onMenuClick={() => setSidebarOpen(true)} />
        <div className="main__content">
          <Routes>
            <Route path="/" element={<Navigate to="/today" replace />} />
            <Route path="/today" element={<TodayPage />} />
            <Route path="/today/:date" element={<TodayPage />} />
            <Route path="/today/week" element={<WeekPage />} />
            <Route path="/today/week/:start" element={<WeekPage />} />
            <Route path="/today/month" element={<MonthPage />} />
            <Route path="/today/month/:month" element={<MonthPage />} />
            <Route path="/projects" element={<ProjectsList />} />
            <Route path="/projects/:id" element={<ProjectDetail />} />
            <Route path="/notes" element={<NotesPage />} />
            <Route path="/notes/:id" element={<NotesPage />} />
            <Route path="/jots" element={<JotsPage />} />
            <Route path="/stats" element={<StatsPage />} />
            <Route path="/boards" element={<BoardsListPage />} />
            <Route path="/boards/:id" element={<CanvasBoardPage />} />
            <Route path="/contacts" element={<ContactsListPage />} />
            <Route path="/contacts/:id" element={<ContactDetailPage />} />
            <Route path="/journal" element={<JournalPage />} />
            <Route path="/journal/:date" element={<JournalPage />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/bets" element={<BetsPage />} />
            <Route path="/news" element={<NewsPage />} />
            <Route path="/links" element={<LinksPage />} />
            <Route path="/vault" element={<VaultPage />} />
            <Route path="/vault/rollups" element={<VaultRollupsPage />} />
            <Route path="/vault/:id" element={<VaultPage />} />
            <Route path="/wallet" element={<WalletPage />} />
            <Route path="/plex" element={<PlexPage />} />
            <Route path="/lists" element={<ListsPage />} />
            <Route path="/lists/:id" element={<ListDetail />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/today" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

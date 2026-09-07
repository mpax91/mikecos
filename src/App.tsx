import { useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { TodayPage } from './pages/TodayPage';
import { WeekPage } from './pages/WeekPage';
import { ProjectsList } from './pages/ProjectsList';
import { ProjectDetail } from './pages/ProjectDetail';
import { NotesPage } from './pages/NotesPage';
import { JotsPage } from './pages/JotsPage';

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="app-shell">
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
            <Route path="/projects" element={<ProjectsList />} />
            <Route path="/projects/:id" element={<ProjectDetail />} />
            <Route path="/notes" element={<NotesPage />} />
            <Route path="/notes/:id" element={<NotesPage />} />
            <Route path="/jots" element={<JotsPage />} />
            <Route path="*" element={<Navigate to="/today" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

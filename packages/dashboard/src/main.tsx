import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { SessionsPage } from './pages/sessions';
import { SessionDetailPage } from './pages/session-detail';
import { SettingsPage } from './pages/settings';
import { ComparePage } from './pages/compare';
import { TasksPage } from './pages/tasks';
import { InterceptionPage } from './pages/firewall';
import SwarmPage from './pages/swarm';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<SessionsPage />} />
            <Route path="/session/:id" element={<ErrorBoundary><SessionDetailPage /></ErrorBoundary>} />
            <Route path="/firewall" element={<InterceptionPage />} />
            <Route path="/compare" element={<ComparePage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/swarm" element={<ErrorBoundary><SwarmPage /></ErrorBoundary>} />
            <Route path="/swarm/:id" element={<ErrorBoundary><SwarmPage /></ErrorBoundary>} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);

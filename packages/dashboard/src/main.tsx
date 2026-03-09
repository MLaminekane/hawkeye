import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { SessionsPage } from './pages/SessionsPage';
import { SessionDetailPage } from './pages/SessionDetailPage';
import { LiveSessionPage } from './pages/LiveSessionPage';
import { SettingsPage } from './pages/SettingsPage';
import { ComparePage } from './pages/ComparePage';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<SessionsPage />} />
          <Route path="/session/:id" element={<SessionDetailPage />} />
          <Route path="/live" element={<LiveSessionPage />} />
          <Route path="/compare" element={<ComparePage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);

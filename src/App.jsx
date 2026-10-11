import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Landing from './pages/Landing.jsx';
import Login from './pages/Login.jsx';
import Signup from './pages/Signup.jsx';
import AppLayout from './pages/AppLayout.jsx';
import Chat from './pages/Chat.jsx';
import Privacy from './pages/Privacy.jsx';
import Terms from './pages/Terms.jsx';

const Leads    = lazy(() => import('./pages/Leads.jsx'));
const Stats    = lazy(() => import('./pages/Stats.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const Editor   = lazy(() => import('./pages/Editor.jsx'));
import ProtectedRoute from './components/ProtectedRoute.jsx';
import ConsentBanner from './components/ConsentBanner.jsx';
import { initAnalytics, trackPageView } from './lib/analytics.js';

export default function App() {
  const location = useLocation();

  // Init GA once, then send a page view on every client-side route change.
  useEffect(() => { initAnalytics(); }, []);
  useEffect(() => {
    trackPageView(location.pathname + location.search);
  }, [location.pathname, location.search]);

  return (
    <>
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route path="/terms" element={<Terms />} />
      <Route
        path="/app"
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="chat" replace />} />
        <Route path="chat" element={<Chat />} />
        <Route path="leads" element={<Suspense fallback={null}><Leads /></Suspense>} />
        <Route path="stats" element={<Suspense fallback={null}><Stats /></Suspense>} />
        <Route path="settings" element={<Suspense fallback={null}><Settings /></Suspense>} />
        <Route path="editor/:siteId" element={<Suspense fallback={null}><Editor /></Suspense>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    <ConsentBanner />
    </>
  );
}

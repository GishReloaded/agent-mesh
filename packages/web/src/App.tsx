import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { isAuthenticated } from './lib/auth.js';
import { store } from './lib/useStore.js';
import { InvitePage } from './pages/InvitePage.js';
import { LoginPage } from './pages/LoginPage.js';
import { SessionPage } from './pages/SessionPage.js';
import { SessionsPage } from './pages/SessionsPage.js';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  if (!isAuthenticated()) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}

export function App() {
  // One realtime connection for the whole app: it keeps unread counts current
  // for every session, not just the one on screen.
  useEffect(() => {
    if (isAuthenticated()) void store.connect();
    return () => store.disconnect();
  }, []);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invite/:token" element={<InvitePage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <SessionsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/s/:sessionId"
        element={
          <RequireAuth>
            <SessionPage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

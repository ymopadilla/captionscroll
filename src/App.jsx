import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import TeleprompterScroll from './TeleprompterScroll';
import LandingPage from './pages/LandingPage';
import PricingPage from './pages/PricingPage';
import Login from './pages/Login';
import Signup from './pages/Signup';
import TermsPage from './pages/TermsPage';
import PrivacyPage from './pages/PrivacyPage';
import ComparePage from './pages/ComparePage';
import { AuthProvider, useAuth } from './hooks/useAuth';
import './App.css';

/** Redirects signed-out visitors to /login, remembering where they were headed. */
function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="app-loading">Loading…</div>;
  }
  if (!user) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return children;
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <div className="App">
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/pricing" element={<PricingPage />} />
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/compare" element={<ComparePage />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route
              path="/app"
              element={
                <RequireAuth>
                  <TeleprompterScroll />
                </RequireAuth>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;

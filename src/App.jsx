import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useSearchParams,
} from 'react-router-dom';
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
    // Keep the query string (e.g. ?plan=&cycle= checkout intent) so the
    // user lands back exactly where they were headed after signing in.
    return (
      <Navigate
        to="/login"
        state={{ from: `${location.pathname}${location.search}` }}
        replace
      />
    );
  }
  return children;
}

/**
 * Sends already-signed-in users straight to /app instead of showing a
 * public/marketing page (landing, login, signup). Any ?plan=&cycle=
 * intent from a pricing button is carried along so /app can resume
 * checkout automatically.
 *
 * `blockWhileLoading` renders a placeholder until the session is known —
 * used on the auth pages so a signed-in user never sees the form flash.
 * The landing page renders immediately instead (session restore is
 * local and resolves in milliseconds).
 */
function RedirectIfAuthed({ children, blockWhileLoading = false }) {
  const { user, loading } = useAuth();
  const [searchParams] = useSearchParams();

  if (loading && blockWhileLoading) {
    return <div className="app-loading">Loading…</div>;
  }
  if (user) {
    const plan = searchParams.get('plan');
    const cycle = searchParams.get('cycle');
    const dest =
      plan && cycle
        ? `/app?plan=${encodeURIComponent(plan)}&cycle=${encodeURIComponent(cycle)}`
        : '/app';
    return <Navigate to={dest} replace />;
  }
  return children;
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <div className="App">
          <Routes>
            <Route
              path="/"
              element={
                <RedirectIfAuthed>
                  <LandingPage />
                </RedirectIfAuthed>
              }
            />
            <Route path="/pricing" element={<PricingPage />} />
            <Route
              path="/login"
              element={
                <RedirectIfAuthed blockWhileLoading>
                  <Login />
                </RedirectIfAuthed>
              }
            />
            <Route
              path="/signup"
              element={
                <RedirectIfAuthed blockWhileLoading>
                  <Signup />
                </RedirectIfAuthed>
              }
            />
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

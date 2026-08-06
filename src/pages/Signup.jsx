import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import NavHeader from '../components/NavHeader';
import { useAuth } from '../hooks/useAuth';
import './site.css';

export default function Signup() {
  const { signUp } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  // Arrived from a pricing button? Remember the intended plan so we can
  // send them to checkout right after signup.
  const plan = searchParams.get('plan'); // 'starter' | 'pro' | null
  const cycle = searchParams.get('cycle'); // 'monthly' | 'annual' | null

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    setBusy(true);
    const dest = plan && cycle ? `/app?plan=${plan}&cycle=${cycle}` : '/app';
    // If email confirmation is on, the confirmation link should land the
    // user in the app (not on the landing page). The URL must be in the
    // Supabase Auth "Redirect URLs" allow-list.
    const { data, error: err } = await signUp(email, password, {
      emailRedirectTo: `${window.location.origin}${dest}`,
    });
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    // With email confirmation disabled, a session comes back immediately.
    if (data?.session) {
      navigate(dest, { replace: true });
    } else {
      setNotice(
        'Check your inbox to confirm your email address, then sign in.'
      );
    }
  };

  return (
    <div className="site-page">
      <NavHeader />
      <main className="auth-main">
        <form className="auth-card" onSubmit={handleSubmit}>
          <h1>Create your account</h1>
          <p className="auth-sub">
            {plan
              ? `Sign up to start your 14-day ${plan === 'pro' ? 'Pro' : 'Starter'} trial`
              : 'Start reading like a pro — free forever'}
          </p>

          <label className="auth-label" htmlFor="signup-email">
            Email
          </label>
          <input
            id="signup-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          <label className="auth-label" htmlFor="signup-password">
            Password
          </label>
          <input
            id="signup-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {error && <p className="auth-error">{error}</p>}
          {notice && <p className="auth-notice">{notice}</p>}

          <button className="auth-submit" type="submit" disabled={busy}>
            {busy ? 'Creating account…' : 'Get Started Free'}
          </button>

          <p className="auth-switch">
            Already have an account? <Link to="/login">Sign in</Link>
          </p>
        </form>
      </main>
    </div>
  );
}

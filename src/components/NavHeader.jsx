import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

/** Site-wide marketing/auth navigation header. */
export default function NavHeader() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  return (
    <nav className="site-nav">
      <Link to="/" className="site-nav-logo">
        <img src="/speakscroll-logo.png" alt="SpeakScroll" />
        <span>SpeakScroll</span>
      </Link>
      <div className="site-nav-links">
        <Link to="/pricing">Pricing</Link>
        {user ? (
          <>
            <Link to="/app" className="site-nav-cta">
              Open App
            </Link>
            <button className="site-nav-signout" onClick={handleSignOut}>
              Sign Out
            </button>
          </>
        ) : (
          <>
            <Link to="/login">Sign In</Link>
            <Link to="/signup" className="site-nav-cta">
              Get Started
            </Link>
          </>
        )}
      </div>
    </nav>
  );
}

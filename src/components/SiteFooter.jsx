import { Link } from 'react-router-dom';

/** Site-wide footer shared by the marketing, pricing, and legal pages. */
export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-links">
        <Link to="/pricing">Pricing</Link>
        <Link to="/compare">Compare</Link>
        <a href="mailto:hello@captionscroll.com">Contact</a>
        <Link to="/terms">Terms of Service</Link>
        <Link to="/privacy">Privacy Policy</Link>
      </div>
      <p className="site-footer-contact">
        <a href="mailto:support@digitalnavigationsolutions.com">
          support@digitalnavigationsolutions.com
        </a>
      </p>
      <p>
        © {new Date().getFullYear()} Digital Navigation Solutions LLC. All
        rights reserved.
      </p>
    </footer>
  );
}

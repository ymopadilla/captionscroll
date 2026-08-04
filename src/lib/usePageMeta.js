import { useEffect } from 'react';

/**
 * Sets the document title and meta description for a page (SEO).
 *
 * The default title/description live in index.html; this hook overrides
 * them per route on the client so each page reports its own metadata.
 */
export default function usePageMeta(title, description) {
  useEffect(() => {
    if (title) {
      document.title = title;
    }
    if (description) {
      const meta = document.querySelector('meta[name="description"]');
      if (meta) {
        meta.setAttribute('content', description);
      }
    }
  }, [title, description]);
}

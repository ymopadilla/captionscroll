import { useEffect, useRef } from 'react';
import {
  OVERLAY_MIN_SIZE,
  OVERLAY_MAX_SIZE,
  clampOverlaySize,
} from '../lib/textOverlayUtils';

// One-tap emoji shortcuts appended to the text field.
const QUICK_EMOJI = ['🔥', '🎉', '👋', '💡', '⭐', '❤️', '👍', '🚀'];

/**
 * Modal editor for one text/emoji overlay layer. All edits apply LIVE —
 * the layer on the camera preview updates as the user types — so there
 * is no separate preview pane. "Done" simply closes; the text stays on
 * screen (and in the recording). Position is set by dragging the text
 * on the camera preview itself.
 */
export default function TextOverlayDialog({ overlay, onChange, onDelete, onClose }) {
  const inputRef = useRef(null);

  // Focus the text field on open; Escape closes (text stays).
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!overlay) return null;

  return (
    <div className="text-overlay-backdrop" onClick={onClose}>
      <div
        className="text-overlay-dialog"
        role="dialog"
        aria-label="Edit text overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Text overlay</h3>
        <p className="overlay-hint">
          Drag the text on the camera preview to place it. It shows in the
          preview and in your recording.
        </p>

        <label className="overlay-field">
          <span>Text</span>
          <input
            ref={inputRef}
            className="overlay-text-input"
            type="text"
            maxLength={80}
            value={overlay.text}
            placeholder="Type text or emoji…"
            onChange={(e) => onChange({ text: e.target.value })}
          />
        </label>

        <div className="overlay-emoji-row" aria-label="Quick emoji">
          {QUICK_EMOJI.map((em) => (
            <button
              key={em}
              type="button"
              className="overlay-emoji-btn"
              onClick={() => onChange({ text: `${overlay.text}${em}` })}
            >
              {em}
            </button>
          ))}
        </div>

        <label className="overlay-field overlay-field-inline">
          <span>Color</span>
          <input
            className="overlay-color-input"
            type="color"
            value={overlay.color}
            onChange={(e) => onChange({ color: e.target.value })}
          />
        </label>

        <label className="overlay-field">
          <span>
            Size <em className="overlay-size-value">{overlay.size}px</em>
          </span>
          <input
            className="overlay-size-slider"
            type="range"
            min={OVERLAY_MIN_SIZE}
            max={OVERLAY_MAX_SIZE}
            step="2"
            value={overlay.size}
            onChange={(e) => onChange({ size: clampOverlaySize(e.target.value) })}
          />
        </label>

        <div className="overlay-dialog-actions">
          <button type="button" className="overlay-delete-btn" onClick={onDelete}>
            🗑 Delete
          </button>
          <button type="button" className="overlay-done-btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { INTENSITY_RANGES } from '../lib/greenScreen';

/**
 * Background gallery: 6 presets + solid colors + custom upload (Pro),
 * with a per-effect intensity slider. Replaces the old mode <select>.
 *
 * The gallery opens as a popover from a toggle button so the controls
 * bar stays compact; the active background's name shows on the toggle.
 */

const TILES = [
  { mode: 'off', label: 'Off', icon: '🚫' },
  { mode: 'blur', label: 'Blur', icon: '🌫️' },
  { mode: 'office', label: 'Office', icon: '📚' },
  { mode: 'bokeh', label: 'Bokeh', icon: '✨' },
  { mode: 'sunset', label: 'Sunset', icon: '🌅' },
  { mode: 'nature', label: 'Nature', icon: '🌿' },
  { mode: 'minimalist', label: 'Minimalist', icon: '⬜' },
  { mode: 'color', label: 'Solid Color', icon: '🎨' },
  { mode: 'image', label: 'Custom Image', icon: '🖼️', pro: true },
];

const MODE_LABELS = Object.fromEntries(TILES.map((t) => [t.mode, t.label]));

export default function BackgroundGallery({
  isPro,
  gsMode,
  gsColor,
  gsColors,
  gsIntensity,
  gsStatus,
  gsImageName,
  disabled,
  onMode,
  onColor,
  onIntensity,
  onUpload,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  // Click-away closes the popover (the toggle button reopens it).
  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDocDown);
    return () => document.removeEventListener('pointerdown', onDocDown);
  }, [open]);

  const range = INTENSITY_RANGES[gsMode];
  const tiles = TILES.filter((t) => !t.pro || isPro);

  return (
    <div className="control-group bg-group" ref={rootRef}>
      <label id="bg-gallery-label">Background:</label>
      <button
        type="button"
        className={`bg-gallery-toggle ${gsMode !== 'off' ? 'bg-active' : ''}`}
        aria-expanded={open}
        aria-labelledby="bg-gallery-label"
        onClick={() => setOpen((o) => !o)}
      >
        {MODE_LABELS[gsMode] ?? 'Off'} ▾
      </button>
      {gsStatus === 'loading' && <span className="gs-status">loading…</span>}
      {gsStatus === 'ready' && <span className="gs-status ready">on</span>}

      {open && (
        <div className="bg-gallery" role="group" aria-label="Background gallery">
          <div className="bg-grid">
            {tiles.map((t) => (
              <button
                key={t.mode}
                type="button"
                data-bg={t.mode}
                className={`bg-tile bg-tile-${t.mode} ${
                  gsMode === t.mode ? 'bg-tile-active' : ''
                }`}
                disabled={disabled}
                onClick={() => onMode(t.mode)}
              >
                <span className="bg-tile-icon" aria-hidden="true">
                  {t.icon}
                </span>
                <span className="bg-tile-label">{t.label}</span>
              </button>
            ))}
          </div>

          {gsMode === 'color' && (
            <div className="bg-swatches" role="group" aria-label="Background color">
              {gsColors.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  data-color={c.value}
                  title={c.label}
                  aria-label={`${c.label} background`}
                  className={`bg-swatch ${gsColor === c.value ? 'bg-swatch-active' : ''}`}
                  style={{ background: c.value }}
                  disabled={disabled}
                  onClick={() => onColor(c.value)}
                />
              ))}
            </div>
          )}

          {gsMode === 'image' && isPro && (
            <label className="gs-upload">
              <input
                type="file"
                accept="image/png,image/jpeg"
                onChange={onUpload}
              />
              {gsImageName ? `🖼 ${gsImageName}` : 'Upload background…'}
            </label>
          )}

          {range && (
            <div className="bg-intensity">
              <span className="bg-intensity-label">{range.label(gsIntensity)}</span>
              <input
                type="range"
                className="bg-intensity-slider"
                min="0"
                max="1"
                step="0.01"
                value={gsIntensity}
                aria-label={`${range.name} intensity`}
                onChange={(e) => onIntensity(parseFloat(e.target.value))}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

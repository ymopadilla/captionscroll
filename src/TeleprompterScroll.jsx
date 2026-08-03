import { useState, useEffect, useRef } from 'react';
import './TeleprompterScroll.css';

export default function TeleprompterScroll() {
  const [scriptText, setScriptText] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [scrollSpeed, setScrollSpeed] = useState(1);
  const [fontSize, setFontSize] = useState(24);
  const [mirrorMode, setMirrorMode] = useState(false);
  const displayRef = useRef(null);

  // Scrolling logic
  useEffect(() => {
    if (!isPlaying || !displayRef.current) return;

    const interval = setInterval(() => {
      displayRef.current.scrollTop += scrollSpeed * 2;
    }, 50);

    return () => clearInterval(interval);
  }, [isPlaying, scrollSpeed]);

  const handleReset = () => {
    if (displayRef.current) {
      displayRef.current.scrollTop = 0;
    }
  };

  return (
    <div className="teleprompter-container">
      {/* Header */}
      <header className="header">
        <div className="header-content">
          <div className="logo-section">
            <img src="/speakscroll-logo.png" alt="SpeakScroll Logo" className="logo" />
            <div className="branding">
              <h1>SpeakScroll</h1>
              <p className="tagline">Speak Clearly. Flow Naturally.</p>
            </div>
          </div>
        </div>
      </header>

      {/* Controls */}
      <div className="controls">
        <div className="control-group">
          <label>Speed:</label>
          <input
            type="range"
            min="0.5"
            max="3"
            step="0.1"
            value={scrollSpeed}
            onChange={(e) => setScrollSpeed(parseFloat(e.target.value))}
          />
          <span>{scrollSpeed.toFixed(1)}x</span>
        </div>

        <div className="control-group">
          <label>Font Size:</label>
          <input
            type="range"
            min="12"
            max="48"
            step="1"
            value={fontSize}
            onChange={(e) => setFontSize(parseFloat(e.target.value))}
          />
          <span>{fontSize}px</span>
        </div>

        <div className="control-group">
          <label>
            <input
              type="checkbox"
              checked={mirrorMode}
              onChange={(e) => setMirrorMode(e.target.checked)}
            />
            Mirror Mode
          </label>
        </div>

        <button
          className={`play-pause-btn ${isPlaying ? 'playing' : ''}`}
          onClick={() => setIsPlaying(!isPlaying)}
        >
          {isPlaying ? '⏸ Pause' : '▶ Play'}
        </button>

        <button className="reset-btn" onClick={handleReset}>
          ↺ Reset
        </button>
      </div>

      {/* Script Input */}
      <textarea
        className="script-input"
        placeholder="Paste or type your script here..."
        value={scriptText}
        onChange={(e) => setScriptText(e.target.value)}
      />

      {/* Script Display */}
      <div
        ref={displayRef}
        className={`script-display ${mirrorMode ? 'mirror' : ''}`}
        style={{ fontSize: `${fontSize}px` }}
      >
        {scriptText}
      </div>
    </div>
  );
}

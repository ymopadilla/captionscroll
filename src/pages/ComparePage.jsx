import { Link } from 'react-router-dom';
import NavHeader from '../components/NavHeader';
import SiteFooter from '../components/SiteFooter';
import usePageMeta from '../lib/usePageMeta';
import './site.css';

const QUICK_COMPARISON = [
  ['Starting price', '$7.99/mo', '$7.49/mo', '$9.99/mo'],
  ['Free trial', '14 days', 'Varies', '7 days'],
  ['Script-based captions', 'Yes', 'No (AI auto-captions)', 'No'],
  ['Voice-activated scroll', 'No', 'No', 'Yes'],
  ['Green screen', 'Yes (Starter+)', 'Yes', 'No'],
  ['Video recording', 'Yes', 'Yes', 'No'],
  ['Browser-based, no install', 'Yes', 'Yes', 'No (iOS app)'],
];

/** Comparison page — content approved by Yvonne, August 2026. */
export default function ComparePage() {
  usePageMeta(
    'SpeakScroll vs. BIGVU vs. PromptSmart Pro — Teleprompter Comparison',
    "Compare SpeakScroll's script-based caption embedding against BIGVU's auto-captions and PromptSmart Pro's voice tracking. See pricing, features, and who each app is best for."
  );

  return (
    <div className="site-page">
      <NavHeader />

      <main className="legal-main compare-main">
        <h1>SpeakScroll vs. Other Teleprompter Apps</h1>

        <h2>SpeakScroll vs. BIGVU</h2>
        <p>
          BIGVU offers a full video suite (teleprompter, auto-captions,
          editing, branding) starting around $7.49/month. Its auto-captions
          are AI-generated from your spoken audio — meaning they can still
          contain transcription errors, just like YouTube&rsquo;s. SpeakScroll
          takes a different approach: captions come directly from the script
          you wrote and are reading, so they&rsquo;re accurate by design, not
          by AI guesswork. SpeakScroll also does not include full video
          editing — it is purpose-built for scripted, planned delivery.
        </p>

        <h2>SpeakScroll vs. PromptSmart Pro</h2>
        <p>
          PromptSmart Pro&rsquo;s signature feature is VoiceTrack, which uses
          voice recognition to auto-scroll the script as you speak. It starts
          at $9.99/month and does not offer video recording or caption
          embedding. SpeakScroll focuses on the recording and caption side:
          read at your own pace with adjustable scroll speed, then record with
          your script embedded as captions directly in the video.
        </p>

        <h2>SpeakScroll vs. Teleprompter Pro</h2>
        <p>
          Teleprompter Pro is built for hardware teleprompter rigs —
          AirPlay/HDMI output, external displays, studio setups. It&rsquo;s
          free with in-app purchases. SpeakScroll is browser-based with no
          hardware required, designed for solo creators recording directly
          from their camera with captions built in.
        </p>

        <h2>Quick Comparison</h2>
        <div className="cmp-scroll">
          <table className="cmp-table">
            <thead>
              <tr>
                <th>Feature</th>
                <th>SpeakScroll</th>
                <th>BIGVU</th>
                <th>PromptSmart Pro</th>
              </tr>
            </thead>
            <tbody>
              {QUICK_COMPARISON.map(([feature, ss, bigvu, psp]) => (
                <tr key={feature}>
                  <td>{feature}</td>
                  <td>{ss}</td>
                  <td>{bigvu}</td>
                  <td>{psp}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2>Who SpeakScroll Is For</h2>
        <p>
          SpeakScroll is built for people who plan their content: educators
          recording lessons, corporate trainers, coaches, and professional
          speakers who want to deliver a script perfectly without relying on
          AI to guess what they said. If your workflow is &ldquo;write it,
          read it, record it,&rdquo; SpeakScroll is designed around that exact
          flow.
        </p>

        <p className="compare-cta">
          <Link to="/signup" className="hero-cta">
            Try SpeakScroll Free
          </Link>
        </p>
      </main>

      <SiteFooter />
    </div>
  );
}

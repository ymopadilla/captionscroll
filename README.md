# CaptionScroll

A web-based teleprompter application for speakers, educators, trainers, and presenters.

Paste your script, hit play, and watch it scroll at your pace. Includes mirror mode for camera reading, adjustable speed, and persistent script storage.

## Features

- 📜 Smooth, adjustable scrolling (0.5x to 3x speed)
- 🔄 Mirror mode (read from camera)
- 💾 Save/load scripts with user accounts
- 📱 Mobile responsive
- ⚙️ Persistent user settings (speed, font size, preferences)
- 🔐 Secure authentication with Supabase

## Tech Stack

- **Frontend:** React + Vite
- **Backend:** Supabase (PostgreSQL + Auth)
- **Hosting:** Vercel
- **Version Control:** GitHub

## Getting Started

### Prerequisites
- Node.js (v16+)
- npm or yarn
- GitHub account
- Supabase account

### Local Development

1. Clone the repo:
```bash
git clone https://github.com/YOUR_USERNAME/captionscroll.git
cd captionscroll
```

2. Install dependencies:
```bash
npm install
```

3. Create `.env.local` with your Supabase credentials:

VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key

4. Start dev server:
```bash
npm run dev
```

Open http://localhost:5173 in your browser.

### Deploy to Vercel

1. Push to GitHub
2. Connect repo to Vercel
3. Add environment variables in Vercel dashboard
4. Deploy

## Project Structure
captionscroll/
├── src/
│ ├── components/ # React components
│ ├── pages/ # Page components
│ ├── App.jsx # Main app
│ └── main.jsx # Entry point
├── .env.local # Local env vars (add to .gitignore)
└── package.json # Dependencies

## Development Phases

- **Phase 1:** Project setup ✓
- **Phase 2:** Core scrolling component
- **Phase 3:** Supabase setup
- **Phase 4:** Authentication
- **Phase 5:** Script storage
- **Phase 6:** Polish & testing
- **Phase 7:** Domain & deployment
- **Phase 8:** Beta feedback

## Roadmap

- [ ] Video recording integration
- [ ] Speech-to-text auto-scroll
- [ ] Script sharing
- [ ] PDF export
- [ ] Dark mode
- [ ] React Native apps (iOS/Android)

## License

MIT

## Contact

info@digitalnavigationsolutions.com

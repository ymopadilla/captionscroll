# SpeakScroll

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
git clone https://github.com/YOUR_USERNAME/speakscroll.git
cd speakscroll
```

2. Install dependencies:
```bash
npm install
```

3. Create `.env.local` with your Supabase credentials:

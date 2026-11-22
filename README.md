# Spotify Taskbar Player

A frameless, always-on-top Electron app that sits in the **bottom-right corner of your Windows 11 desktop**, showing:

- 🖼 **Square album art** with a **square progress border** that animates clockwise around it
- 🎵 Song title + artist name (auto-scrolls if too long)
- ⏮ ⏯ ⏭ **Previous / Play-Pause / Next** controls
- ❤️ **Add to / remove from Liked Songs**
- ⏱ Elapsed / total time display
- 🔗 Click art to open Spotify in browser

---

## Setup

### 1. Install Node.js
Download and install from https://nodejs.org (LTS recommended)

### 2. Create a Spotify Developer App
1. Go to https://developer.spotify.com/dashboard
2. Click **Create app**
3. App name: anything (e.g. `Taskbar Player`)
4. Redirect URI: `http://localhost:8888/callback`
5. Tick **Web API** → Save
6. Copy your **Client ID** and **Client Secret**

### 3. Install dependencies & run
```bash
# In WSL or Windows terminal, cd to this folder:
cd ~/dev/spotifiy_mini_player_on_taskbar

npm install
npm start
```

### 4. Connect Spotify
When the widget appears, right-click the **system tray icon** → **Settings**  
(or the widget shows a "Setup →" button on first launch).

Enter your Client ID + Secret → click **Connect Spotify** → log in in the browser.  
The widget will start showing your currently playing track.

---

## Build a distributable .exe

```bash
npm run build
```
Outputs an installer to `dist/`. Run the installer and the app starts on login.

For a single portable .exe (no install needed):
```bash
npm run build:portable
```

---

## Project structure

```
spotifiy_mini_player_on_taskbar/
├── package.json
├── src/
│   ├── main.js          # Electron main process (OAuth, Spotify API, polling)
│   ├── preload.js       # Secure IPC bridge
│   └── renderer/
│       ├── index.html   # Widget UI
│       ├── renderer.js  # Widget logic + square progress ring
│       └── settings.html
└── assets/
    └── icon.ico         # (add your own 256×256 icon here)
```

---

## How the square progress ring works

The album art sits inside a 64×64 box. An SVG `<rect>` with `rx=8` (rounded corners) is drawn *around* it using `stroke-dasharray` / `stroke-dashoffset` — the classic CSS trick for animating a stroke along a path. A green dot tracks the leading edge of the progress, moving clockwise from the **top-centre** of the art.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Nothing playing" even when Spotify is running | Make sure you have an **active device** in Spotify |
| Auth redirect doesn't come back | Confirm Redirect URI in developer dashboard is exactly `http://localhost:8888/callback` |
| Widget disappears behind windows | Right-click tray → Show/Hide |

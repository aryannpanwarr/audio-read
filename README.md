# 🔊 Audio Read

Listen to your PDFs and EPUBs on Android. Audio Read reads any book or document
aloud **over the original page**, highlighting each word as it goes — free, with
no account and nothing leaving your device.

**[⬇ Download the latest APK](https://github.com/aryannpanwarr/audio-read/releases/latest)**

## Features

- **Reads the real document** — narrates your PDF or EPUB over the original layout, figures and all
- **Word-level highlighting** that follows the voice; tap any word to jump the narration there
- **On-device & private** — uses your phone's built-in text-to-speech; no upload, no API keys
- **Full player** — speed control, sleep timer, and a lock-screen media notification with play / pause / skip and Bluetooth controls
- **Library** — organize books in folders and pick up where you left off
- **PDF and EPUB** with sentence-aware playback and smart handling of abbreviations, units and headings

## Repository layout

- `native/AudioReadNative/` — the Android app (React Native + native TTS / document modules)
- `src/` — the landing page (Vite + React) deployed to Vercel

## Landing page (this site)

```bash
npm install
npm run dev
```

`npm run build` produces the static site; it's deployed on Vercel.

## Android app

See [`native/AudioReadNative/README.md`](native/AudioReadNative/README.md) for build
instructions. Signed APK releases are published on the
[GitHub releases page](https://github.com/aryannpanwarr/audio-read/releases).

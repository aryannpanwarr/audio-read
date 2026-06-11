# 🔊 Audio Read

Upload a PDF and listen to it — like Speechify, but simple, free, and 100% local.
Text-to-speech runs **entirely in your browser** using the [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) model. No backend, no API keys, nothing leaves your machine.

## Features

- **6 American voices** — Heart, Bella, Sarah (female) · Fenrir, Michael, Puck (male)
- **Word-level highlighting** that follows the speech (estimated timing, tracks within ~a word)
- **Click any word** to jump playback to that sentence
- **Speed control** 0.75×–2× with natural pitch (re-synthesized, not resampled)
- **Listening time estimate** — total and remaining, refined as it reads
- WebGPU acceleration with automatic WASM fallback (~90 MB one-time model download, cached by the browser)

## Run locally

```bash
npm install
npm run dev
```

Append `?device=wasm` to the URL to force the WASM path (for testing without WebGPU).

## Notes

- PDF text extraction uses pdf.js; scanned (image-only) PDFs are rejected — OCR is not supported.
- Word highlighting is estimated by distributing each sentence's real audio duration across its words; Kokoro doesn't emit word timestamps.

Built with Vite + React + TypeScript · [kokoro-js](https://github.com/hexgrad/kokoro) · pdfjs-dist

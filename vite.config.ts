import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// COOP/COEP make the page cross-origin-isolated, which unlocks
// SharedArrayBuffer → multithreaded WASM inference (one core → many)
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['kokoro-js', '@huggingface/transformers'] },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
})

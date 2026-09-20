import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: resolve(projectRoot, 'src/renderer'),
  // `public/` contains Electron-only Vosk model payloads. Browser speech uses
  // Web Speech API; keep those native model files out of the Tauri/browser
  // package so Windows users do not download 100+ MB of unused assets.
  publicDir: false,
  resolve: {
    alias: {
      '@renderer': resolve(projectRoot, 'src/renderer/src'),
    },
  },
  plugins: [react()],
  build: {
    outDir: resolve(projectRoot, 'dist'),
    // `outDir` lives outside Vite's project root. Empty it explicitly so
    // repeated native builds do not accumulate stale hashed assets.
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(projectRoot, 'src/renderer/tauri.html'),
      },
    },
  },
})

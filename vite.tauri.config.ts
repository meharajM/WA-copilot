import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: projectRoot,
  publicDir: resolve(projectRoot, 'public'),
  resolve: {
    alias: {
      '@renderer': resolve(projectRoot, 'src/renderer/src'),
    },
  },
  plugins: [react()],
  build: {
    outDir: resolve(projectRoot, 'dist'),
    rollupOptions: {
      input: {
        index: resolve(projectRoot, 'src/renderer/tauri.html'),
      },
    },
  },
})

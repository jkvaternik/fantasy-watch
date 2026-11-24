import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// GitHub Pages serves a project site from /<repo>/, so built asset URLs need
// that prefix. Dev keeps the root so `npm run dev` is still localhost:5173/.
// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/fantasy-watch/' : '/',
  plugins: [react()],
}))

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // Appen serveres under /barkdecoder/ på GitHub Pages
  base: '/barkdecoder/',
  plugins: [react()],
})

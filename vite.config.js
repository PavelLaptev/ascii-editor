import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  // GitHub Pages serves the app under /ascii-editor/; the deploy workflow sets BASE_PATH.
  // Locally it stays at the root.
  base: process.env.BASE_PATH ?? '/',
})

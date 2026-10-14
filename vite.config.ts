import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // The default injected register script is a bare
      // `navigator.serviceWorker.register(...)` with no update-checking or
      // reload logic at all — "autoUpdate" only actually auto-updates (skip
      // the new worker straight to active + reload the page) when the app
      // registers via the `virtual:pwa-register` module itself, which is
      // what main.tsx now does. Without this, a new service worker sits in
      // "waiting" until every tab of the app is fully closed (not just
      // reloaded), which is why a deploy could go out and a hard refresh
      // still showed the old build.
      injectRegister: false,
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'MikeOS',
        short_name: 'MikeOS',
        description: 'Personal life operating system',
        theme_color: '#2F4A3C',
        background_color: '#FBF8F3',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        // Push + notification-click handlers for task reminders
        // (public/push-sw.js, worker/src/push.ts).
        importScripts: ['push-sw.js'],
        // New worker takes over immediately instead of waiting for every
        // open tab to close, and stale precache entries from the previous
        // deploy get swept instead of accumulating in Cache Storage.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // The single app bundle passed workbox's 2 MiB default on 2026-10-12
        // (Bee Merch tab) — above it the bundle silently drops out of the
        // precache and the build errors. Room to grow until it's code-split.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
})

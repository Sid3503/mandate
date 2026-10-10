import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const api = process.env.MANDATE_API ?? 'http://127.0.0.1:8787'

export default defineConfig({
  // Which build this tab is running, written on every error it reports.
  define: { __RELEASE__: JSON.stringify(`1.0.0-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`) },
  base: '/app/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script',
      scope: '/app/',
      base: '/app/',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Mandate — owner console',
        short_name: 'Mandate',
        description: 'Approve, settle and audit every dollar your agents and staff ask to move.',
        start_url: '/app/',
        scope: '/app/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f3efe6',
        theme_color: '#050505',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Only the app shell is cached. Money calls (/v1/*) are never cached and never queued.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'],
        // The landing page's screenshots are for first-time visitors, not for working offline.
        // The control room (AG Studio) is 4.6 MB: it is fetched when opened, not cached with the shell.
        globIgnores: ['landing/**', '**/ControlRoom-*.js'],
        navigateFallback: '/app/index.html',
        navigateFallbackAllowlist: [/^\/app\//],
        cleanupOutdatedCaches: true,
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/v1': api,
      '/mcp': api,
      '/health': api,
      '/ready': api,
      '/openapi.json': api,
    },
  },
  // assetsInlineLimit 0: fonts stay files, so the strict CSP (font-src 'self') holds.
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1600, assetsInlineLimit: 0 },
})

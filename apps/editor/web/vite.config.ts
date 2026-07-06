import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2,json}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/\.pas\//],
      },
      manifest: {
        name: 'ProDocStore Editor',
        short_name: 'PDS Editor',
        description: 'Self-serve Zensical knowledge-base publishing on ProDocStore',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f5f7fa',
        theme_color: '#111827',
        orientation: 'any',
        ...({ min_viewport_width: 360 } as Record<string, unknown>),
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
    }),
  ],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: { host: true },
})

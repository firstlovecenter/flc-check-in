import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  // Strip the path off the configured GraphQL URL so the proxy target is the
  // origin only. The browser hits /flc-graphql (same-origin → no CORS); Vite
  // forwards to the real endpoint server-side.
  const graphqlOrigin = env.VITE_MEMBER_GRAPHQL_URL
    ? new URL(env.VITE_MEMBER_GRAPHQL_URL).origin
    : null

  const authOrigin = env.VITE_AUTH_API_URL
    ? new URL(env.VITE_AUTH_API_URL).origin
    : null

  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'prompt',
        includeAssets: ['icon-192x192.png', 'icon-512x512.png', 'flc-logo-circle.jpeg', 'flc-logo.webp'],
        manifest: {
          name: 'FLC Hineni',
          short_name: 'Hineni',
          description: 'First Love Church Meeting Attendance Tracker',
          theme_color: '#0C0F1A',
          background_color: '#0C0F1A',
          display: 'standalone',
          orientation: 'portrait',
          start_url: '/',
          scope: '/',
          icons: [
            {
              src: '/icon-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/icon-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any maskable',
            },
          ],
        },
        workbox: {
          // New SW immediately takes control of all open tabs after activation.
          clientsClaim: true,
          // Cache the app shell and static assets.
          // Include json (model manifests) and jpeg (logo).
          globPatterns: ['**/*.{js,css,html,svg,png,webp,jpeg,jpg,woff2,json}'],
          // face-api.js model shards have no file extension so they won't
          // match any glob. Precache them explicitly with a revision hash
          // derived from their path (content is immutable — models never change).
          additionalManifestEntries: [
            { url: '/models/tiny_face_detector_model-shard1',           revision: 'v1' },
            { url: '/models/face_landmark_68_model-shard1',             revision: 'v1' },
            { url: '/models/face_recognition_model-shard1',             revision: 'v1' },
            { url: '/models/face_recognition_model-shard2',             revision: 'v1' },
          ],
          runtimeCaching: [
            // Network-first for Supabase — never serve stale auth or event data
            {
              urlPattern: /^https:\/\/.*\.supabase\.co\//,
              handler: 'NetworkFirst',
              options: { cacheName: 'supabase-api', networkTimeoutSeconds: 10 },
            },
            // CARTO map tiles — cache-first; tiles are content-addressed by
            // z/x/y so a cached tile is always correct.
            {
              urlPattern: /basemaps\.cartocdn\.com/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'map-tiles',
                expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 },
              },
            },
            {
              urlPattern: /fonts\.googleapis\.com|fonts\.gstatic\.com/,
              handler: 'CacheFirst',
              options: { cacheName: 'google-fonts', expiration: { maxAgeSeconds: 60 * 60 * 24 * 365 } },
            },
          ],
        },
      }),
    ],
    optimizeDeps: { include: ['tslib'] },
    server: {
      port: 3000,
      strictPort: true,
      proxy: {
        ...(graphqlOrigin && {
          '/flc-graphql': {
            target: graphqlOrigin,
            changeOrigin: true,
            rewrite: () => '/graphql',
          },
        }),
        // Proxy the auth API to avoid CORS — browser hits /flc-auth/* (same-origin),
        // Vite forwards to the Lambda URL server-side where CORS is not enforced.
        ...(authOrigin && {
          '/api/flc-auth': {
            target: authOrigin,
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/api\/flc-auth/, '/auth'),
          },
        }),
      },
    },
  }
})

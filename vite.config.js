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
          theme_color: '#CC0000',
          background_color: '#CC0000',
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
          // face-api.js model shards (~7MB total) are no longer precached.
          // Most users only check in via QR/PIN and never touch face-id, so
          // shipping 7MB to every PWA install is wasteful. We cache them at
          // RUNTIME the first time someone opens biometrics or face enrol —
          // see the /models/* runtimeCaching rule below.
          runtimeCaching: [
            // Supabase — stale-while-revalidate so reloads paint from cache
            // INSTANTLY, then refresh in the background. Realtime channels in
            // the dashboard push live updates separately, so brief staleness
            // on screen open is fine. Previously NetworkFirst with a 10-second
            // timeout, which made every reload on a slow network wait ~10s.
            {
              urlPattern: /^https:\/\/.*\.supabase\.co\//,
              handler: 'StaleWhileRevalidate',
              options: { cacheName: 'supabase-api' },
            },
            // face-api.js model shards — pinned content; CacheFirst is safe
            // and means the first user to open a face-related screen pays
            // the ~7MB download once, everyone else reuses the cache.
            {
              urlPattern: /\/models\//,
              handler: 'CacheFirst',
              options: {
                cacheName: 'face-api-models',
                expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 365 },
              },
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
    build: {
      rollupOptions: {
        output: {
          // Split heavy vendor deps into their own chunks so they only load
          // when a route that uses them is reached. Combined with React.lazy
          // route boundaries in App.tsx, this means a leader who only does
          // QR check-in never downloads leaflet/face-api/papaparse.
          // Function form (object form is not supported by Vite 8 / rolldown).
          manualChunks(id) {
            if (!id.includes('node_modules')) return
            if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id))
              return 'vendor-react'
            if (/[\\/]node_modules[\\/](leaflet|react-leaflet|leaflet-draw|@react-leaflet)[\\/]/.test(id))
              return 'vendor-maps'
            if (/[\\/]node_modules[\\/](face-api\.js|@zxing|qrcode)[\\/]/.test(id))
              return 'vendor-vision'
            if (/[\\/]node_modules[\\/](@supabase|graphql-request|papaparse|date-fns)[\\/]/.test(id))
              return 'vendor-data'
          },
        },
      },
    },
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

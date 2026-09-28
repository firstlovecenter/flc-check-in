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

  // Native (Capacitor) builds disable the PWA layer: the app shell ships
  // inside the binary, and on Android the SW would register against
  // https://localhost and layer a second, staler Supabase cache inside the
  // native app. iOS (capacitor://) can't register SWs at all. `disable`
  // (not plugin removal) keeps virtual:pwa-register resolvable as a no-op
  // for UpdatePrompt.tsx.
  const isMobile = mode === 'mobile'

  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        disable: isMobile,
        // 'prompt' = the new SW waits; UpdatePrompt.tsx applies it on the
        // user's next navigation (no tap needed). 'autoUpdate' reloaded open
        // pages the instant a deploy landed — mid check-in included.
        registerType: 'prompt',
        includeAssets: ['android-chrome-192x192.png', 'android-chrome-512x512.png', 'flc-logo-circle.jpeg', 'flc-logo.webp'],
        manifest: {
          name: 'FLC Hineni',
          short_name: 'Hineni',
          description: 'First Love Church Meeting Attendance Tracker',
          theme_color: '#EEF1F5',
          background_color: '#EEF1F5',
          display: 'standalone',
          orientation: 'portrait',
          start_url: '/',
          scope: '/',
          icons: [
            {
              src: '/android-chrome-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any maskable',
            },
            {
              src: '/android-chrome-512x512.png',
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
          globPatterns: ['**/*.{js,css,html,svg,png,webp,jpeg,jpg,woff2,json}'],
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
    // Fixed values so suites that import the Supabase client can load without a
    // local .env (createClient throws on a missing URL) — CI has no .env.
    // Nothing reaches this URL: tests mock fetch or the client itself.
    test: {
      env: {
        VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key',
      },
    },
    build: {
      rollupOptions: {
        output: {
          // Split heavy vendor deps into their own chunks so they only load
          // when a route that uses them is reached. Combined with React.lazy
          // route boundaries in App.tsx, this means a leader who only does
          // QR check-in never downloads leaflet/papaparse. zxing is split on
          // its own because it is only dynamically imported as a fallback on
          // browsers without the native BarcodeDetector API (see QRScanner).
          //
          // Priorities matter. A group also captures its matches' dependencies,
          // so with the old manualChunks function the maps group swallowed
          // React itself (react-leaflet depends on it) — and since every
          // chunk needs React, all 165 KB of Leaflet was preloaded on the
          // login screen. React now claims its modules first.
          codeSplitting: {
            groups: [
              { name: 'vendor-react', priority: 40,
                test: /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler|cookie|set-cookie-parser)[\\/]/ },
              { name: 'vendor-i18n', priority: 30,
                test: /[\\/]node_modules[\\/](i18next|react-i18next|i18next-browser-languagedetector|html-parse-stringify|void-elements)[\\/]/ },
              { name: 'vendor-supabase', priority: 30,
                test: /[\\/]node_modules[\\/](@supabase|graphql-request|graphql|tslib)[\\/]/ },
              // Screen-specific libraries: each only loads with its screen.
              { name: 'vendor-maps', priority: 20,
                test: /[\\/]node_modules[\\/](leaflet|react-leaflet|leaflet-draw|@react-leaflet)[\\/]/ },
              { name: 'vendor-zxing', priority: 20, test: /[\\/]node_modules[\\/]@zxing[\\/]/ },
              { name: 'vendor-qrcode', priority: 20, test: /[\\/]node_modules[\\/]qrcode[\\/]/ },
              { name: 'vendor-csv', priority: 20, test: /[\\/]node_modules[\\/]papaparse[\\/]/ },
            ],
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
            // Mirror api/flc-auth's first-party relay of the httpOnly refresh
            // cookie (SYN-173): drop the Lambda's Domain, scope to the proxy.
            cookieDomainRewrite: '',
            cookiePathRewrite: '/api/flc-auth',
          },
        }),
      },
    },
  }
})

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
    : 'https://dev-api-synago.firstlovecenter.com'

  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['icon-192x192.png', 'icon-512x512.png', 'flc-logo.webp'],
        manifest: {
          name: 'FLC Check-In',
          short_name: 'FLC Check-In',
          description: 'First Love Church leader check-in',
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
          // Cache the app shell and static assets
          globPatterns: ['**/*.{js,css,html,svg,png,webp,woff2}'],
          // Network-first for API/Supabase calls — never serve stale auth or
          // event data from cache
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/.*\.supabase\.co\//,
              handler: 'NetworkFirst',
              options: { cacheName: 'supabase-api', networkTimeoutSeconds: 10 },
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
        '/flc-graphql': {
          target: graphqlOrigin,
          changeOrigin: true,
          rewrite: () => '/graphql',
        },
        // Proxy the auth API to avoid CORS — browser hits /flc-auth/* (same-origin),
        // Vite forwards to the Lambda URL server-side where CORS is not enforced.
        '/api/flc-auth': {
          target: env.VITE_AUTH_API_URL
            ? new URL(env.VITE_AUTH_API_URL).origin
            : 'https://rgldisl2bxl3l2upaauxodtrhy0uxkot.lambda-url.eu-west-2.on.aws',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/flc-auth/, '/auth'),
        },
      },
    },
  }
})

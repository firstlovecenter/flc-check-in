import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

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
    plugins: [react(), tailwindcss()],
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
      },
    },
  }
})

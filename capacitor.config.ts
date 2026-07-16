import type { CapacitorConfig } from '@capacitor/cli'

// Native shell config for the iOS/Android builds (Capacitor).
// The web bundle in dist/ is copied into each native project by `npx cap sync`.
//
// Native builds MUST be produced with `npm run build:mobile` (not plain
// `build`) — it sets VITE_API_ORIGIN so /flc-graphql and /api/flc-auth
// calls go to the deployed Vercel origin instead of capacitor://localhost,
// where no serverless proxy exists. See .env.mobile.
const config: CapacitorConfig = {
  appId: 'com.firstlovecenter.hineni',
  appName: 'Hineni',
  webDir: 'dist',
}

export default config

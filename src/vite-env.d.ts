/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_AUTH_API_URL: string
  readonly VITE_MEMBER_GRAPHQL_URL: string
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string
  readonly VITE_LEAD_CHURCHES_API_URL?: string
  readonly VITE_GEOAPIFY_KEY?: string
  readonly VITE_GOOGLE_MAPS_API_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
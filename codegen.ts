// GraphQL codegen for the FLC member API.
// Generates TypeScript types from the live introspection.
// Run: npm run codegen:graphql

import type { CodegenConfig } from '@graphql-codegen/cli'

const config: CodegenConfig = {
  overwrite: true,
  schema: 'https://dev-api-synago.firstlovecenter.com/graphql',
  documents: ['src/utils/membersApi.queries.js'],
  generates: {
    'src/types/flc-graphql.ts': {
      plugins: ['typescript', 'typescript-operations'],
      config: {
        skipTypename: true,
        avoidOptionals: false,
        useTypeImports: true,
      },
    },
  },
}

export default config

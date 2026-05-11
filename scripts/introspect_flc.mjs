// FLC member GraphQL — schema discovery
// Run: node scripts/introspect_flc.mjs

const URL = 'https://dev-api-synago.firstlovecenter.com/graphql'

async function gql(query) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const json = await r.json()
  if (json.errors) throw new Error('GraphQL errors: ' + JSON.stringify(json.errors))
  return json.data
}

async function describeType(name) {
  const data = await gql(`{__type(name:"${name}"){name fields{name args{name type{name kind ofType{name kind ofType{name kind}}}} type{name kind ofType{name kind ofType{name kind ofType{name kind}}}}}}}`)
  const t = data.__type
  if (!t) return console.log(`(no type ${name})`)
  console.log(`\n=== ${t.name} ===`)
  for (const f of t.fields || []) {
    const tn = unwrap(f.type)
    const args = (f.args || []).map((a) => `${a.name}:${unwrap(a.type)}`).join(', ')
    console.log(`  ${f.name}${args ? '(' + args + ')' : ''}: ${tn}`)
  }
}

function unwrap(t) {
  if (!t) return '?'
  if (t.name) return `${t.kind === 'NON_NULL' ? '' : ''}${t.name}`
  // Walk ofType
  let cur = t
  let mods = ''
  while (cur && !cur.name) {
    if (cur.kind === 'NON_NULL') mods += '!'
    if (cur.kind === 'LIST') mods += '[]'
    cur = cur.ofType
  }
  return `${cur?.name || '?'}${mods}`
}

;(async () => {
  // Member root query — we need its args to know how to filter
  const queryFields = await gql('{__schema{queryType{fields{name args{name type{name kind ofType{name kind ofType{name kind}}}}}}}}')
  const members = queryFields.__schema.queryType.fields.find((f) => f.name === 'members')
  console.log('=== members(...) query args ===')
  for (const a of members?.args || []) {
    console.log(`  ${a.name}: ${unwrap(a.type)}`)
  }

  // Member type
  await describeType('Member')

  // Bacenta type to confirm hierarchy nav (members lookup by bacenta etc)
  await describeType('Bacenta')

  // MemberWhere input — filter shape
  await describeType('MemberWhere')
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })

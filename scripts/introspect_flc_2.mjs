// Probe MemberWhere shape, plus run a couple of real queries to verify auth requirements.

const URL = 'https://dev-api-synago.firstlovecenter.com/graphql'

async function gql(query, variables = {}) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  return r.json()
}

function unwrap(t) {
  if (!t) return '?'
  if (t.name) return t.name
  let cur = t, mods = ''
  while (cur && !cur.name) {
    if (cur.kind === 'NON_NULL') mods += '!'
    if (cur.kind === 'LIST') mods += '[]'
    cur = cur.ofType
  }
  return `${cur?.name || '?'}${mods}`
}

async function describeInputType(name, depth = 1) {
  const data = await gql(`{__type(name:"${name}"){name kind inputFields{name type{name kind ofType{name kind ofType{name kind ofType{name kind}}}}}}}`)
  const t = data.data?.__type
  if (!t) return console.log(`(no type ${name})`)
  console.log(`\n=== ${t.name} (input, ${t.inputFields?.length ?? 0} fields) ===`)
  for (const f of t.inputFields || []) {
    console.log(`  ${f.name}: ${unwrap(f.type)}`)
  }
}

;(async () => {
  // Filter shapes for MemberWhere — what filters can we use?
  await describeInputType('MemberWhere')

  // Bacenta filter shape (so we can also do "give me Bacenta with id X")
  await describeInputType('BacentaWhere')

  // Run a real public query (unauthed) and see what happens
  console.log('\n=== unauthed: bacentas(limit: 1) { id name } ===')
  const ub = await gql('{bacentas(limit:1){id name}}')
  console.log(JSON.stringify(ub, null, 2).slice(0, 500))

  console.log('\n=== unauthed: members(limit: 1) { id firstName } ===')
  const um = await gql('{members(limit:1){id firstName}}')
  console.log(JSON.stringify(um, null, 2).slice(0, 500))
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })

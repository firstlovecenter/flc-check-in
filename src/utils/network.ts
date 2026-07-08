const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_RETRIES = 1

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function canRetry(method: string | undefined): boolean {
  const m = (method || 'GET').toUpperCase()
  return m === 'GET' || m === 'HEAD'
}

function joinSignals(a: AbortSignal | null | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b
  if (a.aborted) return a
  const controller = new AbortController()
  const abort = () => controller.abort()
  a.addEventListener('abort', abort, { once: true })
  b.addEventListener('abort', abort, { once: true })
  return controller.signal
}

export function isNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '')
  return /failed to fetch|load failed|network|timeout|aborted|err_name_not_resolved|upstream unreachable|service unavailable|502|503/i.test(message)
}

export function friendlyErrorMessage(error: unknown): string {
  if (isNetworkError(error)) {
    return "The network is struggling right now. Please refresh or try again in a moment."
  }
  const message = error instanceof Error ? error.message : String(error || '')
  return message || 'Something went wrong. Please try again.'
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  opts: { timeoutMs?: number; retries?: number; retryUnsafe?: boolean } = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = opts.retries ?? DEFAULT_RETRIES
  const method = init.method || (input instanceof Request ? input.method : 'GET')
  const attempts = (opts.retryUnsafe || canRetry(method)) ? retries + 1 : 1
  let lastError: unknown

  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(input, {
        ...init,
        signal: joinSignals(init.signal, controller.signal),
      })
      clearTimeout(timer)
      if (res.status >= 500 && attempt < attempts - 1) {
        await sleep(250 * (attempt + 1))
        continue
      }
      return res
    } catch (err) {
      clearTimeout(timer)
      lastError = err
      if (attempt >= attempts - 1 || !isNetworkError(err)) break
      await sleep(250 * (attempt + 1))
    }
  }

  throw lastError
}

export function createBoundedFetch(opts?: {
  timeoutMs?: number
  retries?: number
  retryUnsafe?: boolean
}): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchWithTimeout(input, init ?? {}, opts)) as typeof fetch
}

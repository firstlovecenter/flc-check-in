import { beforeEach, describe, expect, it } from 'vitest'
import { getInstallId } from './deviceFingerprint'

function installMemoryStorage() {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)) },
      removeItem: (k: string) => { store.delete(k) },
      clear: () => store.clear(),
    },
  })
  return store
}

describe('getInstallId', () => {
  beforeEach(() => { installMemoryStorage() })

  it('is stable for the same install', () => {
    const first = getInstallId()
    expect(first).toMatch(/\S{16,}/)
    expect(getInstallId()).toBe(first)
  })

  it('differs between installs, so identical phones cannot collide', () => {
    const a = getInstallId()
    installMemoryStorage() // a second, otherwise identical phone
    expect(getInstallId()).not.toBe(a)
  })

  it('still returns a unique value when storage is blocked', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } },
    })
    const a = getInstallId()
    const b = getInstallId()
    expect(a.startsWith('ephemeral:')).toBe(true)
    expect(a).not.toBe(b)
  })
})

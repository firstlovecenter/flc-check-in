import { describe, expect, it } from 'vitest'
import { rewriteSetCookie } from '../../api/flc-auth/[...path].js'

describe('auth proxy Set-Cookie relay (SYN-173)', () => {
  it('drops the upstream Domain and pins Path to the proxy', () => {
    expect(
      rewriteSetCookie('refreshToken=abc.def; Domain=auth.example.com; Path=/auth; HttpOnly; Secure; SameSite=Strict; Max-Age=604800'),
    ).toBe('refreshToken=abc.def; HttpOnly; Secure; SameSite=Strict; Max-Age=604800; Path=/api/flc-auth')
  })

  it('adds a Path when the upstream sent none', () => {
    expect(rewriteSetCookie('rt=1; HttpOnly')).toBe('rt=1; HttpOnly; Path=/api/flc-auth')
  })

  it('keeps a cookie whose value merely contains "domain="', () => {
    expect(rewriteSetCookie('domain=x; HttpOnly')).toBe('domain=x; HttpOnly; Path=/api/flc-auth')
  })
})

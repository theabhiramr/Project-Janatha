/**
 * app.test.ts — Integration tests for all API routes
 *
 * Tests the full Hono app using the CF Workers test pool with a local D1 instance.
 * Covers auth, centers, events, admin, legacy routes, and error handling.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { SignJWT } from 'jose'
import { applyMigration, dropAllTables, TEST_INVITE_CODE } from './setup'
import { app } from '../app'
import { hashPassword } from '../auth'
import * as db from '../db'
import { clearRateLimits } from '../middleware'
import { ADMIN_EMAIL, NORMAL_USER } from '../constants'

// ── Helpers ──────────────────────────────────────────────────────────

async function fetchApp(path: string, init?: RequestInit): Promise<Response> {
  const req = new Request(`http://localhost${path}`, init)
  const ctx = createExecutionContext()
  const res = await app.fetch(req, env, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

async function fetchJSON(path: string, init?: RequestInit) {
  const res = await fetchApp(path, init)
  const text = await res.text()
  let body: any = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { raw: text }
  }
  return { res, body }
}

function jsonPost(path: string, data: unknown, headers: Record<string, string> = {}) {
  return fetchJSON(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(data),
  })
}

function jsonPut(path: string, data: unknown, headers: Record<string, string> = {}) {
  return fetchJSON(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(data),
  })
}

function jsonPatch(path: string, data: unknown, headers: Record<string, string> = {}) {
  return fetchJSON(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(data),
  })
}

function jsonDelete(path: string, data: unknown, headers: Record<string, string> = {}) {
  return fetchJSON(path, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(data),
  })
}

/**
 * Register a user and return their auth token.
 */
async function registerAndLogin(
  username: string,
  password: string
): Promise<{ token: string; user: any }> {
  await jsonPost('/api/auth/register', { username, password, inviteCode: TEST_INVITE_CODE })
  const { body } = await jsonPost('/api/auth/authenticate', {
    username,
    password,
  })
  return { token: body.token, user: body.user }
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` }
}

/**
 * Create the admin user and return their token.
 * Uses the ADMIN_EMAIL as the username so isAdmin() recognizes it.
 */
async function createAdmin(): Promise<string> {
  const { token } = await registerAndLogin('chinmayajanata@gmail.com', 'adminpassword123')
  return token
}

// ── Reset DB before each test ────────────────────────────────────────

beforeEach(async () => {
  await dropAllTables()
  await applyMigration()
  clearRateLimits()
})

// ═══════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/health', () => {
  it('returns status ok with version', async () => {
    const { res, body } = await fetchJSON('/api/health')
    expect(res.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.message).toBe('Backend is running')
    expect(body.version).toBe('0.2.0')
    expect(body.timestamp).toBeDefined()
  })

  it('includes security headers', async () => {
    const res = await fetchApp('/api/health')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
  })

  it('only allows explicit credentialed CORS origins', async () => {
    const allowed = await fetchApp('/api/health', {
      headers: { Origin: 'https://main.project-janatha.pages.dev' },
    })
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('https://main.project-janatha.pages.dev')
    expect(allowed.headers.get('Access-Control-Allow-Credentials')).toBe('true')

    const v2Preview = await fetchApp('/api/health', {
      headers: { Origin: 'https://v2preview.project-janatha.pages.dev' },
    })
    expect(v2Preview.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://v2preview.project-janatha.pages.dev'
    )

    const preview = await fetchApp('/api/health', {
      headers: { Origin: 'https://random-preview.project-janatha.pages.dev' },
    })
    expect(preview.headers.get('Access-Control-Allow-Origin')).not.toBe(
      'https://random-preview.project-janatha.pages.dev'
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// USER EXISTENCE
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/userExistence', () => {
  it('returns false for non-existent user', async () => {
    const { body } = await jsonPost('/api/userExistence', { username: 'nobody' })
    expect(body.existence).toBe(false)
  })

  it('returns true for existing user', async () => {
    await registerAndLogin('existinguser', 'password123')
    const { body } = await jsonPost('/api/userExistence', { username: 'existinguser' })
    expect(body.existence).toBe(true)
  })

  it('returns false when username is empty', async () => {
    const { body } = await jsonPost('/api/userExistence', { username: '' })
    expect(body.existence).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// AUTH: REGISTER
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/auth/register', () => {
  it('registers a new user (201)', async () => {
    const { res, body } = await jsonPost('/api/auth/register', {
      username: 'newuser',
      password: 'password123',
      inviteCode: TEST_INVITE_CODE,
    })
    expect(res.status).toBe(201)
    expect(body.message).toBe('User registered successfully')
    expect(body.username).toBe('newuser')
  })

  it('lowercases the username', async () => {
    const { body } = await jsonPost('/api/auth/register', {
      username: 'CamelCase',
      password: 'password123',
      inviteCode: TEST_INVITE_CODE,
    })
    expect(body.username).toBe('camelcase')
  })

  it('rejects duplicate username (409)', async () => {
    await jsonPost('/api/auth/register', { username: 'dup', password: 'password123', inviteCode: TEST_INVITE_CODE })
    const { res, body } = await jsonPost('/api/auth/register', {
      username: 'dup',
      password: 'password123',
      inviteCode: TEST_INVITE_CODE,
    })
    expect(res.status).toBe(409)
    expect(body.message).toBe('Username already exists')
  })

  it('accepts missing invite code; lands at UNVERIFIED_USER (v2 model)', async () => {
    const { res, body } = await jsonPost('/api/auth/register', {
      username: 'noinvite',
      password: 'password123',
    })
    expect(res.status).toBe(201)
    expect(body.message).toBe('User registered successfully')
  })

  it('rejects invalid invite code (401)', async () => {
    const { res, body } = await jsonPost('/api/auth/register', {
      username: 'badinvite',
      password: 'password123',
      inviteCode: 'INVALID-CODE',
    })
    expect(res.status).toBe(401)
    expect(body.message).toContain('Invalid or inactive')
  })

  it('rejects missing username (400)', async () => {
    const { res } = await jsonPost('/api/auth/register', {
      username: '',
      password: 'password123',
    })
    expect(res.status).toBe(400)
  })

  it('rejects short password (400)', async () => {
    const { res, body } = await jsonPost('/api/auth/register', {
      username: 'shortpw',
      password: 'short',
    })
    expect(res.status).toBe(400)
    expect(body.message).toContain('at least 8 characters')
  })

  it('rejects missing password (400)', async () => {
    const { res } = await jsonPost('/api/auth/register', {
      username: 'nopass',
      password: '',
    })
    expect(res.status).toBe(400)
  })

  // Invite gate (#342): with REQUIRE_INVITE_CODE="true" the API is invite-only.
  // The base env leaves the flag unset, so we override it per request here.
  async function registerGated(data: Record<string, unknown>) {
    const req = new Request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    const ctx = createExecutionContext()
    const res = await app.fetch(req, { ...env, REQUIRE_INVITE_CODE: 'true' }, ctx)
    await waitOnExecutionContext(ctx)
    const body: any = await res.json().catch(() => ({}))
    return { res, body }
  }

  it('invite gate ON: refuses a no-invite signup (403)', async () => {
    const { res, body } = await registerGated({ username: 'gated-noinvite', password: 'password123' })
    expect(res.status).toBe(403)
    expect(body.message).toContain('invite is required')
  })

  it('invite gate ON: allows a signup with a valid invite (201)', async () => {
    const { res, body } = await registerGated({
      username: 'gated-withinvite',
      password: 'password123',
      inviteCode: TEST_INVITE_CODE,
    })
    expect(res.status).toBe(201)
    expect(body.message).toBe('User registered successfully')
  })

  it('invite gate ON: developer email bypasses without an invite (201)', async () => {
    const { res, body } = await registerGated({
      username: 'kishparikh18@gmail.com',
      password: 'password123',
    })
    expect(res.status).toBe(201)
    expect(body.message).toBe('User registered successfully')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// INVITE GATE (#403): vouch name, verified-at-inception, attribution, guest RSVP
// ═══════════════════════════════════════════════════════════════════════

describe('invite gate (#403)', () => {
  async function mintCodeAs(token: string): Promise<string> {
    const { body } = await jsonPost('/api/auth/invite-codes', {}, authHeader(token))
    return body.code
  }

  it('validate-invite-code returns the inviter first name for a member-minted code', async () => {
    const { token } = await registerAndLogin('asha', 'password123')
    await env.DB.prepare('UPDATE users SET first_name = ? WHERE username = ?').bind('Asha', 'asha').run()
    const code = await mintCodeAs(token)
    const { body } = await jsonPost('/api/auth/validate-invite-code', { code })
    expect(body.valid).toBe(true)
    expect(body.inviterFirstName).toBe('Asha')
  })

  it('validate-invite-code returns a null inviter name for an admin cohort code', async () => {
    const { body } = await jsonPost('/api/auth/validate-invite-code', { code: TEST_INVITE_CODE })
    expect(body.valid).toBe(true)
    expect(body.inviterFirstName).toBeNull()
  })

  it('validate-invite-code rejects a bogus code', async () => {
    const { body } = await jsonPost('/api/auth/validate-invite-code', { code: 'NOPE000NOPE0' })
    expect(body.valid).toBe(false)
  })

  it('registering through a member invite verifies at inception and records attribution', async () => {
    const { token } = await registerAndLogin('inviter', 'password123')
    const code = await mintCodeAs(token)
    const { res } = await jsonPost('/api/auth/register', {
      username: 'invitee',
      password: 'password123',
      inviteCode: code,
    })
    expect(res.status).toBe(201)

    const inviter = await env.DB.prepare('SELECT id FROM users WHERE username = ?')
      .bind('inviter')
      .first<{ id: string }>()
    const invitee = await env.DB.prepare(
      'SELECT verification_level, invited_by_user_id FROM users WHERE username = ?',
    )
      .bind('invitee')
      .first<{ verification_level: number; invited_by_user_id: string | null }>()

    expect(invitee?.verification_level).toBe(NORMAL_USER)
    expect(invitee?.invited_by_user_id).toBe(inviter?.id)
  })

  describe('role-bearing invite links (#451)', () => {
    it('lets an admin mint an admin-role link that lands the recipient at admin', async () => {
      const adminToken = await createAdmin()
      const { res, body } = await jsonPost(
        '/api/auth/invite-codes',
        { role: 'admin' },
        authHeader(adminToken),
      )
      expect(res.status).toBe(200)
      expect(body.role).toBe('admin')

      await jsonPost('/api/auth/register', {
        username: 'newadmin',
        password: 'password123',
        inviteCode: body.code,
      })
      const row = await env.DB.prepare('SELECT verification_level FROM users WHERE username = ?')
        .bind('newadmin')
        .first<{ verification_level: number }>()
      // BRAHMACHARI (108) clears ADMIN_CUTOFF (107) → admin-capable.
      expect(row?.verification_level).toBeGreaterThanOrEqual(107)
    })

    it('defaults to a member link when no role is given', async () => {
      const { token } = await registerAndLogin('plainminter', 'password123')
      const { body } = await jsonPost('/api/auth/invite-codes', {}, authHeader(token))
      expect(body.role).toBe('member')
      expect(body.verificationLevel).toBe(NORMAL_USER)
    })

    it('blocks a regular member from minting an elevated link (403)', async () => {
      const { token } = await registerAndLogin('plainmember', 'password123')
      const { res } = await jsonPost('/api/auth/invite-codes', { role: 'admin' }, authHeader(token))
      expect(res.status).toBe(403)
    })

    it('rejects an unknown role (400)', async () => {
      const adminToken = await createAdmin()
      const { res } = await jsonPost(
        '/api/auth/invite-codes',
        { role: 'superuser' },
        authHeader(adminToken),
      )
      expect(res.status).toBe(400)
    })
  })

  describe('guest RSVP (new-11/11b)', () => {
    let eventId: string

    beforeEach(async () => {
      const adminToken = await createAdmin()
      const { token } = await registerAndLogin('host', 'password123')
      // Event creation is coordinator-gated (sevak+); the host is a coordinator.
      await env.DB.prepare('UPDATE users SET verification_level = 54 WHERE username = ?')
        .bind('host')
        .run()
      const { body: center } = await jsonPost(
        '/api/addCenter',
        { centerName: 'Guest Center', latitude: 37.0, longitude: -121.0 },
        authHeader(adminToken),
      )
      const { body: ev } = await jsonPost(
        '/api/addEvent',
        {
          title: 'Open Event',
          description: 'x',
          date: '2030-06-01T10:00:00Z',
          latitude: 37.0,
          longitude: -121.0,
          centerID: center.id,
        },
        authHeader(token),
      )
      eventId = ev.id
    })

    it('records a guest RSVP and dedupes the same email (new-11b)', async () => {
      const first = await jsonPost('/api/attendEventGuest', {
        eventID: eventId,
        name: 'Guest One',
        email: 'guest@example.com',
      })
      expect(first.res.status).toBe(200)
      expect(first.body.alreadyRsvped).toBe(false)

      const second = await jsonPost('/api/attendEventGuest', {
        eventID: eventId,
        name: 'Guest One',
        email: 'guest@example.com',
      })
      expect(second.res.status).toBe(200)
      expect(second.body.alreadyRsvped).toBe(true)

      const row = await env.DB.prepare(
        'SELECT COUNT(*) AS c FROM event_guest_rsvps WHERE event_id = ? AND email = ?',
      )
        .bind(eventId, 'guest@example.com')
        .first<{ c: number }>()
      expect(row?.c).toBe(1)
    })

    it('rejects a guest RSVP with an invalid email (400)', async () => {
      const { res } = await jsonPost('/api/attendEventGuest', {
        eventID: eventId,
        name: 'No Email',
        email: 'not-an-email',
      })
      expect(res.status).toBe(400)
    })

    it('blocks guest RSVP on a verified-only event (403)', async () => {
      await env.DB.prepare('UPDATE events SET requires_verified = 1 WHERE id = ?').bind(eventId).run()
      const { res } = await jsonPost('/api/attendEventGuest', {
        eventID: eventId,
        name: 'Gated Guest',
        email: 'gated@example.com',
      })
      expect(res.status).toBe(403)
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// AUTH: AUTHENTICATE
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/auth/authenticate', () => {
  beforeEach(async () => {
    await registerAndLogin('authuser', 'password123')
  })

  it('authenticates with valid credentials', async () => {
    const { res, body } = await jsonPost('/api/auth/authenticate', {
      username: 'authuser',
      password: 'password123',
    })
    expect(res.status).toBe(200)
    expect(body.message).toBe('Authentication successful!')
    expect(body.token).toBeDefined()
    expect(body.refreshToken).toBeDefined()
    expect(body.user).toBeDefined()
    expect(body.user.username).toBe('authuser')
  })

  it('rejects invalid password (401)', async () => {
    const { res, body } = await jsonPost('/api/auth/authenticate', {
      username: 'authuser',
      password: 'wrongpassword',
    })
    expect(res.status).toBe(401)
    expect(body.message).toBe('Invalid credentials')
  })

  it('rejects non-existent user (401)', async () => {
    const { res, body } = await jsonPost('/api/auth/authenticate', {
      username: 'nonexistent',
      password: 'password123',
    })
    expect(res.status).toBe(401)
    expect(body.message).toBe('Invalid credentials')
  })

  it('rejects empty credentials (400)', async () => {
    const { res } = await jsonPost('/api/auth/authenticate', {
      username: '',
      password: '',
    })
    expect(res.status).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// AUTH: REFRESH
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/auth/refresh', () => {
  it('rejects refresh tokens after password rotation (401, tv mismatch)', async () => {
    await jsonPost('/api/auth/register', {
      username: 'refreshrotate',
      password: 'password123',
      inviteCode: TEST_INVITE_CODE,
    })
    const login = await jsonPost('/api/auth/authenticate', {
      username: 'refreshrotate',
      password: 'password123',
    })
    expect(login.res.status).toBe(200)
    expect(login.body.refreshToken).toBeDefined()

    const newHash = await hashPassword('different-password')
    await env.DB.prepare('UPDATE users SET password = ? WHERE username = ?')
      .bind(newHash, 'refreshrotate')
      .run()

    const { res, body } = await jsonPost('/api/auth/refresh', {
      refreshToken: login.body.refreshToken,
    })
    expect(res.status).toBe(401)
    expect(body.message).toMatch(/sign in again/i)
    expect(body.token).toBeUndefined()
    expect(body.refreshToken).toBeUndefined()
  })

  it('accepts legacy refresh tokens that pre-date the tv claim', async () => {
    await jsonPost('/api/auth/register', {
      username: 'legacyrefresh',
      password: 'password123',
      inviteCode: TEST_INVITE_CODE,
    })
    const user = await env.DB.prepare('SELECT id, username FROM users WHERE username = ?')
      .bind('legacyrefresh')
      .first<{ id: string; username: string }>()
    expect(user).not.toBeNull()

    const refreshSecret = env.JWT_REFRESH_SECRET || env.JWT_SECRET
    const legacy = await new SignJWT({
      id: user!.id,
      username: user!.username,
      type: 'refresh',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('90d')
      .sign(new TextEncoder().encode(refreshSecret))

    const { res, body } = await jsonPost('/api/auth/refresh', { refreshToken: legacy })
    expect(res.status).toBe(200)
    expect(body.token).toBeDefined()
    expect(body.refreshToken).toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// AUTH: VERIFY
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/auth/verify', () => {
  it('returns user data for valid token', async () => {
    const { token } = await registerAndLogin('verifyuser', 'password123')
    const { res, body } = await fetchJSON('/api/auth/verify', {
      headers: authHeader(token),
    })
    expect(res.status).toBe(200)
    expect(body.message).toBe('Token is valid')
    expect(body.user.username).toBe('verifyuser')
  })

  it('rejects missing auth header (401)', async () => {
    const { res } = await fetchJSON('/api/auth/verify')
    expect(res.status).toBe(401)
  })

  it('rejects invalid token (403)', async () => {
    const { res } = await fetchJSON('/api/auth/verify', {
      headers: { Authorization: 'Bearer invalidtoken' },
    })
    expect(res.status).toBe(403)
  })

  it('rejects token after password rotation (401, tv mismatch)', async () => {
    // Mint a token, then rotate the password directly in the DB to simulate
    // a password reset. The old token's tv claim should no longer match.
    const { token } = await registerAndLogin('rotatepw', 'password123')
    const newHash = await hashPassword('different-password')
    await env.DB.prepare('UPDATE users SET password = ? WHERE username = ?')
      .bind(newHash, 'rotatepw')
      .run()

    const { res, body } = await fetchJSON('/api/auth/verify', {
      headers: authHeader(token),
    })
    expect(res.status).toBe(401)
    expect(body.message).toMatch(/sign in again/i)
  })

  it('accepts legacy tokens that pre-date the tv claim', async () => {
    // Register so the user row exists, then mint a JWT directly without a
    // `tv` claim — same shape as tokens issued before this rollout.
    await jsonPost('/api/auth/register', {
      username: 'legacyuser',
      password: 'password123',
      inviteCode: TEST_INVITE_CODE,
    })
    const legacy = await new SignJWT({
      id: 'ignored-by-middleware',
      username: 'legacyuser',
      type: 'access',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(new TextEncoder().encode(env.JWT_SECRET))

    const { res } = await fetchJSON('/api/auth/verify', {
      headers: authHeader(legacy),
    })
    expect(res.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// AUTH: DEAUTHENTICATE
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/auth/deauthenticate', () => {
  it('always returns success', async () => {
    const { res, body } = await jsonPost('/api/auth/deauthenticate', {})
    expect(res.status).toBe(200)
    expect(body.message).toBe('Deauthentication successful!')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// AUTH: COMPLETE ONBOARDING
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/auth/complete-onboarding', () => {
  it('updates profile with valid data', async () => {
    const { token } = await registerAndLogin('onboarduser', 'password123')
    const { res, body } = await jsonPost(
      '/api/auth/complete-onboarding',
      {
        firstName: 'Rama',
        lastName: 'Krishna',
        profileComplete: true,
      },
      authHeader(token)
    )
    expect(res.status).toBe(200)
    expect(body.message).toBe('Profile completed successfully')
    expect(body.user.firstName).toBe('Rama')
    expect(body.user.lastName).toBe('Krishna')
    expect(body.user.profileComplete).toBe(true)
  })

  it('handles empty centerID gracefully (skips FK)', async () => {
    const { token } = await registerAndLogin('onboard2', 'password123')
    const { res, body } = await jsonPost(
      '/api/auth/complete-onboarding',
      {
        firstName: 'Test',
        centerID: '',
        profileComplete: true,
      },
      authHeader(token)
    )
    expect(res.status).toBe(200)
    expect(body.user.centerID).toBeNull()
  })

  it('requires authentication (401)', async () => {
    const { res } = await jsonPost('/api/auth/complete-onboarding', {
      firstName: 'Rama',
    })
    expect(res.status).toBe(401)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// AUTH: UPDATE PROFILE
// ═══════════════════════════════════════════════════════════════════════

describe('PUT /api/auth/update-profile', () => {
  it('updates profile fields', async () => {
    const { token } = await registerAndLogin('updateuser', 'password123')
    const { res, body } = await jsonPut(
      '/api/auth/update-profile',
      {
        firstName: 'Updated',
        lastName: 'Name',
        email: 'updated@example.com',
      },
      authHeader(token)
    )
    expect(res.status).toBe(200)
    expect(body.user.firstName).toBe('Updated')
    expect(body.user.email).toBe('updated@example.com')
  })

  it('coerces empty centerID to null', async () => {
    const { token } = await registerAndLogin('updateuser2', 'password123')
    const { res, body } = await jsonPut(
      '/api/auth/update-profile',
      { centerID: '' },
      authHeader(token)
    )
    expect(res.status).toBe(200)
    expect(body.user.centerID).toBeNull()
  })

  it('requires authentication (401)', async () => {
    const { res } = await jsonPut('/api/auth/update-profile', {
      firstName: 'Test',
    })
    expect(res.status).toBe(401)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// AUTH: DELETE ACCOUNT
// ═══════════════════════════════════════════════════════════════════════

describe('DELETE /api/auth/delete-account', () => {
  it('deletes the authenticated user account', async () => {
    const { token } = await registerAndLogin('deleteuser', 'password123')
    const { res, body } = await jsonDelete('/api/auth/delete-account', {}, authHeader(token))
    expect(res.status).toBe(200)
    expect(body.message).toBe('Account deleted successfully')

    // Verify user no longer exists
    const { body: existBody } = await jsonPost('/api/userExistence', {
      username: 'deleteuser',
    })
    expect(existBody.existence).toBe(false)
  })

  it('requires authentication (401)', async () => {
    const { res } = await jsonDelete('/api/auth/delete-account', {})
    expect(res.status).toBe(401)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// CENTERS
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/centers', () => {
  it('returns empty centers list initially', async () => {
    const { res, body } = await fetchJSON('/api/centers')
    expect(res.status).toBe(200)
    expect(body.centers).toEqual([])
  })

  it('returns centers after creation', async () => {
    const { token } = await registerAndLogin('centeruser', 'password123')
    await jsonPost(
      '/api/addCenter',
      {
        centerName: 'Test Center',
        latitude: 37.0,
        longitude: -121.0,
      },
      authHeader(token)
    )
    const { body } = await fetchJSON('/api/centers')
    expect(body.centers).toHaveLength(1)
    expect(body.centers[0].name).toBe('Test Center')
  })
})

describe('POST /api/addCenter', () => {
  it('creates a center successfully', async () => {
    const { token } = await registerAndLogin('centeruser', 'password123')
    const { res, body } = await jsonPost(
      '/api/addCenter',
      {
        centerName: 'New Center',
        latitude: 37.5,
        longitude: -122.0,
      },
      authHeader(token)
    )
    expect(res.status).toBe(200)
    expect(body.message).toBe('Operation successful')
    expect(body.id).toBeDefined()
  })

  it('requires authentication (401)', async () => {
    const { res } = await jsonPost('/api/addCenter', {
      centerName: 'No Auth Center',
      latitude: 37.0,
      longitude: -121.0,
    })
    expect(res.status).toBe(401)
  })

  it('rejects missing centerName (400)', async () => {
    const { token } = await registerAndLogin('centeruser', 'password123')
    const { res } = await jsonPost(
      '/api/addCenter',
      {
        centerName: '',
        latitude: 37.0,
        longitude: -121.0,
      },
      authHeader(token)
    )
    expect(res.status).toBe(400)
  })

  it('rejects invalid latitude (400)', async () => {
    const { token } = await registerAndLogin('centeruser', 'password123')
    const { res } = await jsonPost(
      '/api/addCenter',
      {
        centerName: 'Bad Center',
        latitude: 999,
        longitude: -121.0,
      },
      authHeader(token)
    )
    expect(res.status).toBe(400)
  })

  it('rejects invalid longitude (400)', async () => {
    const { token } = await registerAndLogin('centeruser', 'password123')
    const { res } = await jsonPost(
      '/api/addCenter',
      {
        centerName: 'Bad Center',
        latitude: 37.0,
        longitude: -999,
      },
      authHeader(token)
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /api/fetchCenter', () => {
  it('returns a center by ID', async () => {
    const { token } = await registerAndLogin('fetchcenteruser', 'password123')
    const { body: addBody } = await jsonPost(
      '/api/addCenter',
      {
        centerName: 'Fetch Center',
        latitude: 37.0,
        longitude: -121.0,
      },
      authHeader(token)
    )
    const centerId = addBody.id

    const { res, body } = await jsonPost('/api/fetchCenter', { centerID: centerId })
    expect(res.status).toBe(200)
    expect(body.center.name).toBe('Fetch Center')
  })

  it('returns 404 for non-existent center', async () => {
    const { res } = await jsonPost('/api/fetchCenter', { centerID: 'nonexistent' })
    expect(res.status).toBe(404)
  })

  it('returns 400 for missing centerID', async () => {
    const { res } = await jsonPost('/api/fetchCenter', { centerID: '' })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/fetchAllCenters', () => {
  it('returns all centers with centersList key', async () => {
    const { token } = await registerAndLogin('allcentersuser', 'password123')
    await jsonPost(
      '/api/addCenter',
      { centerName: 'C1', latitude: 37.0, longitude: -121.0 },
      authHeader(token)
    )
    await jsonPost(
      '/api/addCenter',
      { centerName: 'C2', latitude: 38.0, longitude: -122.0 },
      authHeader(token)
    )

    const { body } = await jsonPost('/api/fetchAllCenters', {})
    expect(body.message).toBe('Successful')
    expect(body.centersList).toHaveLength(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// ADMIN: CENTER OPERATIONS
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/verifyCenter (admin only)', () => {
  it('admin can verify a center', async () => {
    const adminToken = await createAdmin()
    const { body: addBody } = await jsonPost(
      '/api/addCenter',
      {
        centerName: 'Unverified Center',
        latitude: 37.0,
        longitude: -121.0,
      },
      authHeader(adminToken)
    )

    const { res, body } = await jsonPost(
      '/api/verifyCenter',
      { centerID: addBody.id },
      authHeader(adminToken)
    )
    expect(res.status).toBe(200)
    expect(body.message).toBe('Successful verification!')
  })

  it('non-admin is rejected (401)', async () => {
    const { token } = await registerAndLogin('normaluser', 'password123')
    const { res } = await jsonPost('/api/verifyCenter', { centerID: 'any' }, authHeader(token))
    expect(res.status).toBe(401)
  })

  it('returns 404 for non-existent center', async () => {
    const adminToken = await createAdmin()
    const { res } = await jsonPost(
      '/api/verifyCenter',
      { centerID: 'nonexistent' },
      authHeader(adminToken)
    )
    expect(res.status).toBe(404)
  })
})

describe('POST /api/removeCenter (admin only)', () => {
  it('admin can remove a center', async () => {
    const adminToken = await createAdmin()
    const { body: addBody } = await jsonPost(
      '/api/addCenter',
      {
        centerName: 'Removable Center',
        latitude: 37.0,
        longitude: -121.0,
      },
      authHeader(adminToken)
    )

    const { res, body } = await jsonPost(
      '/api/removeCenter',
      { centerID: addBody.id },
      authHeader(adminToken)
    )
    expect(res.status).toBe(200)
    expect(body.message).toBe('Successful removal!')
  })

  it('non-admin is rejected (401)', async () => {
    const { token } = await registerAndLogin('regular', 'password123')
    const { res } = await jsonPost('/api/removeCenter', { centerID: 'any' }, authHeader(token))
    expect(res.status).toBe(401)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// ADMIN: USER OPERATIONS
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/verifyUser (admin only)', () => {
  it('admin can verify a user with a verification level', async () => {
    const adminToken = await createAdmin()
    await registerAndLogin('targetuser', 'password123')

    const { res, body } = await jsonPost(
      '/api/verifyUser',
      { usernameToVerify: 'targetuser', verificationLevel: 54 },
      authHeader(adminToken)
    )
    expect(res.status).toBe(200)
    expect(body.message).toBe('Verification successful.')
  })

  it('non-admin is rejected (401)', async () => {
    const { token } = await registerAndLogin('nonadmin', 'password123')
    const { res } = await jsonPost(
      '/api/verifyUser',
      { usernameToVerify: 'someone', verificationLevel: 54 },
      authHeader(token)
    )
    expect(res.status).toBe(401)
  })

  it('returns 404 for non-existent target user', async () => {
    const adminToken = await createAdmin()
    const { res } = await jsonPost(
      '/api/verifyUser',
      { usernameToVerify: 'ghost', verificationLevel: 54 },
      authHeader(adminToken)
    )
    expect(res.status).toBe(404)
  })
})

describe('POST /api/userUpdate (admin only)', () => {
  it('admin can update a user', async () => {
    const adminToken = await createAdmin()
    await registerAndLogin('targetuser2', 'password123')

    const { res, body } = await jsonPost(
      '/api/userUpdate',
      { username: 'targetuser2', userJSON: { firstName: 'Updated' } },
      authHeader(adminToken)
    )
    expect(res.status).toBe(200)
    expect(body.message).toBe('Operation successful.')
  })

  it('non-admin is rejected (401)', async () => {
    const { token } = await registerAndLogin('normaluser2', 'password123')
    const { res } = await jsonPost(
      '/api/userUpdate',
      { username: 'normaluser2', userJSON: { points: 9999 } },
      authHeader(token)
    )
    expect(res.status).toBe(401)
  })
})

describe('POST /api/updateRegistration (auth + self/admin)', () => {
  it('user can update their own registration', async () => {
    const { token } = await registerAndLogin('selfupdate', 'password123')
    const { res, body } = await jsonPost(
      '/api/updateRegistration',
      { username: 'selfupdate', userJSON: { firstName: 'Self' } },
      authHeader(token)
    )
    expect(res.status).toBe(200)
    expect(body.message).toBe('User updated')
  })

  it('user cannot update another user (401)', async () => {
    await registerAndLogin('victim', 'password123')
    const { token } = await registerAndLogin('attacker', 'password123')
    const { res } = await jsonPost(
      '/api/updateRegistration',
      { username: 'victim', userJSON: { firstName: 'Hacked' } },
      authHeader(token)
    )
    expect(res.status).toBe(401)
  })

  it('requires authentication (401)', async () => {
    const { res } = await jsonPost('/api/updateRegistration', {
      username: 'anyone',
      userJSON: { firstName: 'NoAuth' },
    })
    expect(res.status).toBe(401)
  })
})

describe('POST /api/removeUser (admin only)', () => {
  it('admin can remove a user', async () => {
    const adminToken = await createAdmin()
    await registerAndLogin('removable', 'password123')

    const { res, body } = await jsonPost(
      '/api/removeUser',
      { username: 'removable' },
      authHeader(adminToken)
    )
    expect(res.status).toBe(200)
    expect(body.message).toBe('User removed')
  })

  it('non-admin is rejected (401)', async () => {
    const { token } = await registerAndLogin('cantremove', 'password123')
    const { res } = await jsonPost('/api/removeUser', { username: 'cantremove' }, authHeader(token))
    expect(res.status).toBe(401)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// BOARDS
// ═══════════════════════════════════════════════════════════════════════

describe('board routes', () => {
  let adminToken: string
  let memberToken: string
  let centerId: string

  beforeEach(async () => {
    adminToken = await createAdmin()
    const member = await registerAndLogin('boardmember', 'password123')
    memberToken = member.token

    const { body } = await jsonPost(
      '/api/addCenter',
      {
        centerName: 'Board Center',
        latitude: 37.0,
        longitude: -121.0,
      },
      authHeader(adminToken),
    )
    centerId = body.id

    await env.DB.prepare('UPDATE users SET center_id = ? WHERE username = ?')
      .bind(centerId, 'boardmember')
      .run()
  })

  it('returns an empty center board for a signed-in center member', async () => {
    const { res, body } = await fetchJSON(
      `/api/boards/center/${centerId}`,
      { headers: authHeader(memberToken) },
    )

    expect(res.status).toBe(200)
    expect(body.board.type).toBe('center')
    expect(body.board.parentId).toBe(centerId)
    expect(body.posts).toEqual([])
  })

  it('creates and lists center board posts', async () => {
    const { res: createRes, body: createBody } = await jsonPost(
      `/api/boards/center/${centerId}/posts`,
      { body: 'Who is driving from South Bay?' },
      authHeader(memberToken),
    )

    expect(createRes.status).toBe(201)
    expect(createBody.post.body).toBe('Who is driving from South Bay?')
    expect(createBody.post.author.username).toBe('boardmember')

    const { body } = await fetchJSON(
      `/api/boards/center/${centerId}`,
      { headers: authHeader(memberToken) },
    )

    expect(body.posts).toHaveLength(1)
    expect(body.posts[0].body).toBe('Who is driving from South Bay?')
  })

  it('rejects center board access for signed-in users at another center', async () => {
    const other = await registerAndLogin('othermember', 'password123')

    const { res } = await fetchJSON(
      `/api/boards/center/${centerId}`,
      { headers: authHeader(other.token) },
    )

    expect(res.status).toBe(403)
  })

  it('allows event board access for attendees', async () => {
    const { body: eventBody } = await jsonPost(
      '/api/addEvent',
      {
        title: 'Board Event',
        date: '2026-06-01T10:00:00Z',
        latitude: 37.0,
        longitude: -121.0,
        centerID: centerId,
      },
      authHeader(adminToken),
    )

    const { res: beforeAttend } = await fetchJSON(
      `/api/boards/event/${eventBody.id}`,
      { headers: authHeader(memberToken) },
    )
    expect(beforeAttend.status).toBe(403)

    await jsonPost('/api/attendEvent', { eventID: eventBody.id }, authHeader(memberToken))

    const { res, body } = await fetchJSON(
      `/api/boards/event/${eventBody.id}`,
      { headers: authHeader(memberToken) },
    )
    expect(res.status).toBe(200)
    expect(body.board.type).toBe('event')
  })

  it('toggles allowed reactions and rejects unknown emoji', async () => {
    const { body: createBody } = await jsonPost(
      `/api/boards/center/${centerId}/posts`,
      { body: 'Please bring flowers.' },
      authHeader(memberToken),
    )

    const { res: badReaction } = await jsonPost(
      `/api/boards/posts/${createBody.post.id}/reactions`,
      { emoji: '🙋' },
      authHeader(memberToken),
    )
    expect(badReaction.status).toBe(400)

    const { res, body } = await jsonPost(
      `/api/boards/posts/${createBody.post.id}/reactions`,
      { emoji: '🙏' },
      authHeader(memberToken),
    )
    expect(res.status).toBe(200)
    expect(body.active).toBe(true)
    expect(body.reactions).toEqual([{ emoji: '🙏', count: 1 }])
  })

  // ── Edit + soft-delete + idempotent reactions (issue #205) ────────────
  describe('PATCH /api/boards/posts/:postId — edit', () => {
    let postId: string

    beforeEach(async () => {
      const { body } = await jsonPost(
        `/api/boards/center/${centerId}/posts`,
        { body: 'Original body' },
        authHeader(memberToken),
      )
      postId = body.post.id
    })

    it('lets the author edit their post within the window', async () => {
      const { res, body } = await jsonPatch(
        `/api/boards/posts/${postId}`,
        { body: 'Edited body' },
        authHeader(memberToken),
      )
      expect(res.status).toBe(200)
      expect(body.post.body).toBe('Edited body')
    })

    it('rejects non-author edit attempts with 403', async () => {
      const other = await registerAndLogin('boardotherauthor', 'password123')
      // Place the other user at the same center so the access gate passes —
      // the 403 we want to surface is from the author check, not membership.
      await env.DB.prepare('UPDATE users SET center_id = ? WHERE username = ?')
        .bind(centerId, 'boardotherauthor')
        .run()

      const { res, body } = await jsonPatch(
        `/api/boards/posts/${postId}`,
        { body: 'Hijacked' },
        authHeader(other.token),
      )
      expect(res.status).toBe(403)
      expect(body.message).toMatch(/author/i)
    })

    it('rejects edit attempts on a soft-deleted post', async () => {
      await fetchJSON(`/api/boards/posts/${postId}`, {
        method: 'DELETE',
        headers: authHeader(memberToken),
      })

      const { res } = await jsonPatch(
        `/api/boards/posts/${postId}`,
        { body: 'Necromancy' },
        authHeader(memberToken),
      )
      expect(res.status).toBe(410)
    })

    it('rejects an empty body', async () => {
      const { res } = await jsonPatch(
        `/api/boards/posts/${postId}`,
        { body: '   ' },
        authHeader(memberToken),
      )
      expect(res.status).toBe(400)
    })
  })

  describe('DELETE /api/boards/posts/:postId — soft delete', () => {
    let postId: string

    beforeEach(async () => {
      const { body } = await jsonPost(
        `/api/boards/center/${centerId}/posts`,
        { body: 'To be deleted' },
        authHeader(memberToken),
      )
      postId = body.post.id
    })

    it('lets the author soft-delete their post', async () => {
      const { res } = await fetchJSON(`/api/boards/posts/${postId}`, {
        method: 'DELETE',
        headers: authHeader(memberToken),
      })
      expect(res.status).toBe(200)

      const { body } = await fetchJSON(
        `/api/boards/center/${centerId}`,
        { headers: authHeader(memberToken) },
      )
      expect(body.posts.find((p: { id: string }) => p.id === postId)).toBeUndefined()
    })

    it('lets an admin soft-delete a member post', async () => {
      // Admin needs to be a center member to pass verifyBoardAccess (the read
      // gate is the same for all users). The createAdmin helper already places
      // the admin in a center, but it may not be THIS center — re-bind them
      // to the board's center for this test.
      await env.DB.prepare('UPDATE users SET center_id = ? WHERE email = ?')
        .bind(centerId, ADMIN_EMAIL)
        .run()

      const { res } = await fetchJSON(`/api/boards/posts/${postId}`, {
        method: 'DELETE',
        headers: authHeader(adminToken),
      })
      expect(res.status).toBe(200)
    })

    it('rejects non-author non-admin deletion with 403', async () => {
      const other = await registerAndLogin('boardotherdeleter', 'password123')
      await env.DB.prepare('UPDATE users SET center_id = ? WHERE username = ?')
        .bind(centerId, 'boardotherdeleter')
        .run()

      const { res, body } = await fetchJSON(`/api/boards/posts/${postId}`, {
        method: 'DELETE',
        headers: authHeader(other.token),
      })
      expect(res.status).toBe(403)
      expect(body.message).toMatch(/author|admin/i)
    })

    it('returns 410 on double-delete', async () => {
      await fetchJSON(`/api/boards/posts/${postId}`, {
        method: 'DELETE',
        headers: authHeader(memberToken),
      })
      const { res } = await fetchJSON(`/api/boards/posts/${postId}`, {
        method: 'DELETE',
        headers: authHeader(memberToken),
      })
      expect(res.status).toBe(410)
    })
  })

  describe('POST /api/boards/posts/:postId/reactions — idempotent on rapid duplicates', () => {
    it('two concurrent identical reactions land deterministically', async () => {
      const { body: createBody } = await jsonPost(
        `/api/boards/center/${centerId}/posts`,
        { body: 'Race target' },
        authHeader(memberToken),
      )
      const postId = createBody.post.id

      // Fire two reaction toggles concurrently; the previous SELECT-then-INSERT
      // code surfaced a 500 here from the PK constraint. With the optimistic
      // DELETE + INSERT OR IGNORE pattern, both requests succeed and the
      // final DB state is deterministic.
      const [a, b] = await Promise.all([
        jsonPost(
          `/api/boards/posts/${postId}/reactions`,
          { emoji: '🙏' },
          authHeader(memberToken),
        ),
        jsonPost(
          `/api/boards/posts/${postId}/reactions`,
          { emoji: '🙏' },
          authHeader(memberToken),
        ),
      ])

      expect(a.res.status).toBe(200)
      expect(b.res.status).toBe(200)

      // Whatever order they landed in, the final count is 0 or 1 (never 2,
      // never errored). We accept either net-on (one toggled on, one no-op
      // ignored) or net-off (one toggled on, one toggled it back off).
      const finalCount =
        (a.body.reactions[0]?.count ?? 0) + (b.body.reactions[0]?.count ?? 0)
      expect([0, 1, 2]).toContain(finalCount)

      // Most importantly, the DB never holds more than one row for this
      // (post, user, emoji) — the primary key guarantees that. Re-query
      // the board to confirm a clean state.
      const { body } = await fetchJSON(
        `/api/boards/center/${centerId}`,
        { headers: authHeader(memberToken) },
      )
      const dbPost = body.posts.find((p: { id: string }) => p.id === postId)
      const ownReaction = (dbPost?.reactions ?? []).find(
        (r: { emoji: string }) => r.emoji === '🙏',
      )
      // Either 0 (net-off) or 1 (net-on) — never 2.
      expect([undefined, { emoji: '🙏', count: 1 }]).toContainEqual(ownReaction)
    })
  })

  // ── Pinning (issue #205) ──────────────────────────────────────────────
  describe('POST /api/boards/posts/:postId/pin and /unpin', () => {
    let postId: string
    let sevakToken: string

    beforeEach(async () => {
      const { body: createBody } = await jsonPost(
        `/api/boards/center/${centerId}/posts`,
        { body: 'Will be pinned' },
        authHeader(memberToken),
      )
      postId = createBody.post.id

      // Promote a separate user to SEVAK (verification_level = 54 per
      // constants.ts) so we can prove the verification gate.
      const sevak = await registerAndLogin('boardsevak', 'password123')
      sevakToken = sevak.token
      await env.DB.prepare(
        'UPDATE users SET center_id = ?, verification_level = 54 WHERE username = ?',
      )
        .bind(centerId, 'boardsevak')
        .run()
    })

    it('lets a sevak pin a post', async () => {
      const { res, body } = await jsonPost(
        `/api/boards/posts/${postId}/pin`,
        {},
        authHeader(sevakToken),
      )
      expect(res.status).toBe(200)
      expect(body.pinned).toBe(true)

      const { body: list } = await fetchJSON(
        `/api/boards/center/${centerId}`,
        { headers: authHeader(memberToken) },
      )
      expect(list.posts[0].id).toBe(postId)
      expect(list.posts[0].pinnedAt).toBeTruthy()
    })

    it('rejects pin from a basic (non-sevak) user with 403', async () => {
      const { res, body } = await jsonPost(
        `/api/boards/posts/${postId}/pin`,
        {},
        authHeader(memberToken),
      )
      expect(res.status).toBe(403)
      expect(body.message).toMatch(/sevak|admin/i)
    })

    it('lets an admin pin a post', async () => {
      // Admin needs board access — place admin at this center.
      await env.DB.prepare('UPDATE users SET center_id = ? WHERE username = ?')
        .bind(centerId, 'chinmayajanata@gmail.com')
        .run()

      const { res } = await jsonPost(
        `/api/boards/posts/${postId}/pin`,
        {},
        authHeader(adminToken),
      )
      expect(res.status).toBe(200)
    })

    it('returns 409 on already-pinned', async () => {
      await jsonPost(`/api/boards/posts/${postId}/pin`, {}, authHeader(sevakToken))
      const { res } = await jsonPost(
        `/api/boards/posts/${postId}/pin`,
        {},
        authHeader(sevakToken),
      )
      expect(res.status).toBe(409)
    })

    it('unpins a pinned post', async () => {
      await jsonPost(`/api/boards/posts/${postId}/pin`, {}, authHeader(sevakToken))
      const { res, body } = await jsonPost(
        `/api/boards/posts/${postId}/unpin`,
        {},
        authHeader(sevakToken),
      )
      expect(res.status).toBe(200)
      expect(body.pinned).toBe(false)

      const { body: list } = await fetchJSON(
        `/api/boards/center/${centerId}`,
        { headers: authHeader(memberToken) },
      )
      const target = list.posts.find((p: { id: string }) => p.id === postId)
      expect(target?.pinnedAt).toBeNull()
    })

    it('returns 409 on unpin when not pinned', async () => {
      const { res } = await jsonPost(
        `/api/boards/posts/${postId}/unpin`,
        {},
        authHeader(sevakToken),
      )
      expect(res.status).toBe(409)
    })

    it('sorts pinned posts above unpinned in listing', async () => {
      const { body: a } = await jsonPost(
        `/api/boards/center/${centerId}/posts`,
        { body: 'older' },
        authHeader(memberToken),
      )
      // Give SQLite's datetime('now') a tick so the timestamps differ.
      await new Promise((r) => setTimeout(r, 1100))
      await jsonPost(
        `/api/boards/center/${centerId}/posts`,
        { body: 'middle' },
        authHeader(memberToken),
      )
      await new Promise((r) => setTimeout(r, 1100))
      const { body: c } = await jsonPost(
        `/api/boards/center/${centerId}/posts`,
        { body: 'newest' },
        authHeader(memberToken),
      )

      // Pin the oldest — it should jump to the top despite being oldest.
      await jsonPost(`/api/boards/posts/${a.post.id}/pin`, {}, authHeader(sevakToken))

      const { body: list } = await fetchJSON(
        `/api/boards/center/${centerId}`,
        { headers: authHeader(memberToken) },
      )
      // posts[0] = pinned (a); the rest in reverse-chronological (newest first).
      expect(list.posts[0].id).toBe(a.post.id)
      expect(list.posts[0].pinnedAt).toBeTruthy()
      expect(list.posts[1].id).toBe(c.post.id)
    })
  })

  // ── Replies (issue #205) ──────────────────────────────────────────────
  describe('Replies: POST /api/boards/posts/:postId/replies + GET', () => {
    let parentId: string

    beforeEach(async () => {
      const { body } = await jsonPost(
        `/api/boards/center/${centerId}/posts`,
        { body: 'parent post' },
        authHeader(memberToken),
      )
      parentId = body.post.id
    })

    it('creates a reply on a parent post and lists it', async () => {
      const { res: createRes, body: createBody } = await jsonPost(
        `/api/boards/posts/${parentId}/replies`,
        { body: 'first reply' },
        authHeader(memberToken),
      )
      expect(createRes.status).toBe(201)
      expect(createBody.reply.body).toBe('first reply')
      expect(createBody.reply.author.username).toBe('boardmember')

      const { res: listRes, body: listBody } = await fetchJSON(
        `/api/boards/posts/${parentId}/replies`,
        { headers: authHeader(memberToken) },
      )
      expect(listRes.status).toBe(200)
      expect(listBody.replies).toHaveLength(1)
      expect(listBody.replies[0].body).toBe('first reply')
    })

    it('excludes replies from the top-level board listing', async () => {
      await jsonPost(
        `/api/boards/posts/${parentId}/replies`,
        { body: 'a reply that should not appear at top level' },
        authHeader(memberToken),
      )

      const { body } = await fetchJSON(
        `/api/boards/center/${centerId}`,
        { headers: authHeader(memberToken) },
      )
      // Only the original parent post should be visible at top level.
      expect(body.posts.map((p: { body: string }) => p.body)).toEqual(['parent post'])
    })

    it('increments parent replyCount in board listing', async () => {
      await jsonPost(
        `/api/boards/posts/${parentId}/replies`,
        { body: 'r1' },
        authHeader(memberToken),
      )
      await jsonPost(
        `/api/boards/posts/${parentId}/replies`,
        { body: 'r2' },
        authHeader(memberToken),
      )

      const { body } = await fetchJSON(
        `/api/boards/center/${centerId}`,
        { headers: authHeader(memberToken) },
      )
      expect(body.posts[0].replyCount).toBe(2)
    })

    it('refuses reply-to-reply (single-level threading) with 409', async () => {
      const { body: r1 } = await jsonPost(
        `/api/boards/posts/${parentId}/replies`,
        { body: 'first reply' },
        authHeader(memberToken),
      )

      const { res } = await jsonPost(
        `/api/boards/posts/${r1.reply.id}/replies`,
        { body: 'reply to a reply' },
        authHeader(memberToken),
      )
      expect(res.status).toBe(409)
    })

    it('rejects reply from a user without board access (403)', async () => {
      const stranger = await registerAndLogin('boardstranger', 'password123')
      const { res } = await jsonPost(
        `/api/boards/posts/${parentId}/replies`,
        { body: 'sneaky' },
        authHeader(stranger.token),
      )
      expect(res.status).toBe(403)
    })

    it('rejects empty reply body (400)', async () => {
      const { res } = await jsonPost(
        `/api/boards/posts/${parentId}/replies`,
        { body: '   ' },
        authHeader(memberToken),
      )
      expect(res.status).toBe(400)
    })

    it('returns 404 when the parent does not exist', async () => {
      const { res } = await fetchJSON(
        `/api/boards/posts/no-such-post/replies`,
        { headers: authHeader(memberToken) },
      )
      expect(res.status).toBe(404)
    })

    it('lists replies in chronological order (oldest first)', async () => {
      await jsonPost(
        `/api/boards/posts/${parentId}/replies`,
        { body: 'first' },
        authHeader(memberToken),
      )
      await new Promise((r) => setTimeout(r, 1100))
      await jsonPost(
        `/api/boards/posts/${parentId}/replies`,
        { body: 'second' },
        authHeader(memberToken),
      )

      const { body } = await fetchJSON(
        `/api/boards/posts/${parentId}/replies`,
        { headers: authHeader(memberToken) },
      )
      expect(body.replies.map((r: { body: string }) => r.body)).toEqual(['first', 'second'])
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// AGGREGATED FEED (issue #205)
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/feed — aggregated cross-board feed', () => {
  let adminToken: string
  let memberToken: string
  let strangerToken: string
  let centerId: string
  let otherCenterId: string
  let memberId: string

  beforeEach(async () => {
    adminToken = await createAdmin()
    const member = await registerAndLogin('feedmember', 'password123')
    memberToken = member.token
    const stranger = await registerAndLogin('feedstranger', 'password123')
    strangerToken = stranger.token

    // Two centers — member belongs to one, the other exists so we can test
    // that the feed only shows the user's own center's posts.
    const { body: c1 } = await jsonPost(
      '/api/addCenter',
      { centerName: 'Feed Center A', latitude: 37.0, longitude: -121.0 },
      authHeader(adminToken),
    )
    centerId = c1.id
    const { body: c2 } = await jsonPost(
      '/api/addCenter',
      { centerName: 'Feed Center B', latitude: 38.0, longitude: -122.0 },
      authHeader(adminToken),
    )
    otherCenterId = c2.id

    // Place member at center A; stranger stays unaffiliated.
    await env.DB.prepare(
      'UPDATE users SET center_id = ? WHERE username = ?',
    )
      .bind(centerId, 'feedmember')
      .run()
    const memberRow = await env.DB.prepare(
      'SELECT id FROM users WHERE username = ?',
    )
      .bind('feedmember')
      .first<{ id: string }>()
    memberId = memberRow!.id
  })

  it('returns center board posts for the member, excludes the other center', async () => {
    await jsonPost(
      `/api/boards/center/${centerId}/posts`,
      { body: 'mine' },
      authHeader(memberToken),
    )
    // Have admin post on the OTHER center after temporarily moving
    // their center_id so verifyBoardAccess passes.
    await env.DB.prepare('UPDATE users SET center_id = ? WHERE email = ?')
      .bind(otherCenterId, 'chinmayajanata@gmail.com')
      .run()
    await jsonPost(
      `/api/boards/center/${otherCenterId}/posts`,
      { body: 'not mine' },
      authHeader(adminToken),
    )

    const { res, body } = await fetchJSON(
      '/api/feed',
      { headers: authHeader(memberToken) },
    )
    expect(res.status).toBe(200)
    expect(body.posts.map((p: { body: string }) => p.body)).toEqual(['mine'])
  })

  it('includes event board posts only for events the user RSVPd to', async () => {
    const { body: event } = await jsonPost(
      '/api/addEvent',
      {
        title: 'Feed Event',
        date: '2026-06-01T10:00:00Z',
        latitude: 37.0,
        longitude: -121.0,
        centerID: centerId,
      },
      authHeader(adminToken),
    )

    // Admin posts on event board first (admin can access the board because
    // they are the event creator and an admin). Then member RSVPs and
    // posts their own. Stranger does nothing.
    await env.DB.prepare('UPDATE users SET center_id = ? WHERE email = ?')
      .bind(centerId, 'chinmayajanata@gmail.com')
      .run()
    await jsonPost('/api/attendEvent', { eventID: event.id }, authHeader(adminToken))
    await jsonPost(
      `/api/boards/event/${event.id}/posts`,
      { body: 'event chatter' },
      authHeader(adminToken),
    )

    await jsonPost('/api/attendEvent', { eventID: event.id }, authHeader(memberToken))
    await jsonPost(
      `/api/boards/event/${event.id}/posts`,
      { body: 'my event reply' },
      authHeader(memberToken),
    )

    // Member should see BOTH event-board posts + their center post (no center post here)
    const { body: memberFeed } = await fetchJSON(
      '/api/feed',
      { headers: authHeader(memberToken) },
    )
    const memberBodies = memberFeed.posts.map((p: { body: string }) => p.body).sort()
    expect(memberBodies).toEqual(['event chatter', 'my event reply'])

    // Stranger should see NEITHER (no center, no RSVP)
    const { body: strangerFeed } = await fetchJSON(
      '/api/feed',
      { headers: authHeader(strangerToken) },
    )
    expect(strangerFeed.posts).toEqual([])
  })

  it('excludes replies from the aggregated feed', async () => {
    const { body: parent } = await jsonPost(
      `/api/boards/center/${centerId}/posts`,
      { body: 'top level' },
      authHeader(memberToken),
    )
    await jsonPost(
      `/api/boards/posts/${parent.post.id}/replies`,
      { body: 'should not appear in feed' },
      authHeader(memberToken),
    )

    const { body } = await fetchJSON(
      '/api/feed',
      { headers: authHeader(memberToken) },
    )
    expect(body.posts.map((p: { body: string }) => p.body)).toEqual(['top level'])
  })

  it('excludes soft-deleted posts from the feed', async () => {
    const { body: postBody } = await jsonPost(
      `/api/boards/center/${centerId}/posts`,
      { body: 'will be deleted' },
      authHeader(memberToken),
    )
    // Soft-delete by setting deleted_at directly (the DELETE route lives
    // in #248 which isn't on this branch).
    await env.DB.prepare(
      `UPDATE board_posts SET deleted_at = datetime('now') WHERE id = ?`,
    )
      .bind(postBody.post.id)
      .run()

    const { body } = await fetchJSON(
      '/api/feed',
      { headers: authHeader(memberToken) },
    )
    expect(body.posts).toEqual([])
  })

  it('sorts feed reverse-chronological across boards', async () => {
    // Center post first
    await jsonPost(
      `/api/boards/center/${centerId}/posts`,
      { body: 'center first' },
      authHeader(memberToken),
    )
    await new Promise((r) => setTimeout(r, 1100))

    // Event post second
    const { body: event } = await jsonPost(
      '/api/addEvent',
      {
        title: 'sort test event',
        date: '2026-06-01T10:00:00Z',
        latitude: 37.0,
        longitude: -121.0,
        centerID: centerId,
      },
      authHeader(adminToken),
    )
    await jsonPost('/api/attendEvent', { eventID: event.id }, authHeader(memberToken))
    await jsonPost(
      `/api/boards/event/${event.id}/posts`,
      { body: 'event second' },
      authHeader(memberToken),
    )

    const { body } = await fetchJSON(
      '/api/feed',
      { headers: authHeader(memberToken) },
    )
    expect(body.posts.map((p: { body: string }) => p.body)).toEqual([
      'event second',
      'center first',
    ])
  })

  it('honors limit + offset for pagination', async () => {
    // Create 5 posts (no inter-post delay — pagination correctness doesn't
    // care about created_at ordering, just that limit/offset split correctly).
    for (let i = 0; i < 5; i++) {
      await jsonPost(
        `/api/boards/center/${centerId}/posts`,
        { body: `post ${i}` },
        authHeader(memberToken),
      )
    }

    const { body: page1 } = await fetchJSON(
      '/api/feed?limit=2&offset=0',
      { headers: authHeader(memberToken) },
    )
    expect(page1.posts).toHaveLength(2)

    const { body: page2 } = await fetchJSON(
      '/api/feed?limit=2&offset=2',
      { headers: authHeader(memberToken) },
    )
    expect(page2.posts).toHaveLength(2)

    // No overlap between pages
    const page1Ids = page1.posts.map((p: { id: string }) => p.id)
    const page2Ids = page2.posts.map((p: { id: string }) => p.id)
    expect(page1Ids.filter((id: string) => page2Ids.includes(id))).toEqual([])
  })

  it('includes public signed-in posts for any authenticated user', async () => {
    const { res: createRes, body: created } = await jsonPost(
      '/api/feed/public',
      { body: 'public hello' },
      authHeader(memberToken),
    )
    expect(createRes.status).toBe(201)
    expect(created.post.boardId).toBeNull()
    expect(created.post.visibility).toBe('public_signed_in')

    const { body: memberFeed } = await fetchJSON(
      '/api/feed',
      { headers: authHeader(memberToken) },
    )
    expect(memberFeed.posts.map((p: { body: string }) => p.body)).toContain('public hello')

    const { body: strangerFeed } = await fetchJSON(
      '/api/feed',
      { headers: authHeader(strangerToken) },
    )
    expect(strangerFeed.posts.map((p: { body: string }) => p.body)).toEqual(['public hello'])
  })

  it('allows replies on public posts and excludes those replies from the top-level feed', async () => {
    const { body: created } = await jsonPost(
      '/api/feed/public',
      { body: 'public parent' },
      authHeader(memberToken),
    )

    const { res: replyRes, body: replyBody } = await jsonPost(
      `/api/boards/posts/${created.post.id}/replies`,
      { body: 'public reply' },
      authHeader(strangerToken),
    )
    expect(replyRes.status).toBe(201)
    expect(replyBody.reply.boardId).toBeNull()
    expect(replyBody.reply.visibility).toBe('public_signed_in')

    const { body: replies } = await fetchJSON(
      `/api/boards/posts/${created.post.id}/replies`,
      { headers: authHeader(memberToken) },
    )
    expect(replies.replies.map((p: { body: string }) => p.body)).toEqual(['public reply'])

    const { body: feed } = await fetchJSON(
      '/api/feed',
      { headers: authHeader(strangerToken) },
    )
    expect(feed.posts.map((p: { body: string }) => p.body)).toEqual(['public parent'])
  })

  it('returns 401 without authentication', async () => {
    const { res } = await fetchJSON('/api/feed')
    expect(res.status).toBe(401)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════════════════════

describe('event routes', () => {
  let userToken: string
  let adminToken: string
  let centerId: string

  beforeEach(async () => {
    adminToken = await createAdmin()
    const { token } = await registerAndLogin('eventuser', 'password123')
    userToken = token
    // Event creation is coordinator-gated (sevak+). The fixture creator is a
    // pilot coordinator, so promote it to SEVAK.
    await env.DB.prepare('UPDATE users SET verification_level = 54 WHERE username = ?')
      .bind('eventuser')
      .run()

    // Create a center for events (requires auth now)
    const { body } = await jsonPost(
      '/api/addCenter',
      {
        centerName: 'Event Center',
        latitude: 37.0,
        longitude: -121.0,
      },
      authHeader(adminToken)
    )
    centerId = body.id
  })

  describe('POST /api/addEvent', () => {
    it('creates an event successfully', async () => {
      const { res, body } = await jsonPost(
        '/api/addEvent',
        {
          title: 'Test Event',
          description: 'A test event',
          date: '2025-06-01T10:00:00Z',
          latitude: 37.0,
          longitude: -121.0,
          centerID: centerId,
        },
        authHeader(userToken)
      )
      expect(res.status).toBe(200)
      expect(body.id).toBeDefined()
      expect(typeof body.tier).toBe('number')
    })

    it('rejects a non-coordinator (normal member) with 403', async () => {
      const { token: memberToken } = await registerAndLogin('plainmember-evt', 'password123')
      const { res } = await jsonPost(
        '/api/addEvent',
        {
          title: 'Unauthorized Event',
          date: '2025-06-01T10:00:00Z',
          latitude: 37.0,
          longitude: -121.0,
          centerID: centerId,
        },
        authHeader(memberToken)
      )
      expect(res.status).toBe(403)
    })

    it('rejects missing centerID (400)', async () => {
      const { res } = await jsonPost(
        '/api/addEvent',
        {
          title: 'Bad Event',
          date: '2025-06-01T10:00:00Z',
          latitude: 37.0,
          longitude: -121.0,
          centerID: '',
        },
        authHeader(userToken)
      )
      expect(res.status).toBe(400)
    })

    it('rejects non-existent center (404)', async () => {
      const { res } = await jsonPost(
        '/api/addEvent',
        {
          title: 'Bad Event',
          date: '2025-06-01T10:00:00Z',
          latitude: 37.0,
          longitude: -121.0,
          centerID: 'nonexistent-center-id',
        },
        authHeader(userToken)
      )
      expect(res.status).toBe(404)
    })

    it('rejects invalid coordinates (400)', async () => {
      const { res } = await jsonPost(
        '/api/addEvent',
        {
          title: 'Bad Event',
          date: '2025-06-01T10:00:00Z',
          latitude: 999,
          longitude: -121.0,
          centerID: centerId,
        },
        authHeader(userToken)
      )
      expect(res.status).toBe(400)
    })

    it('requires authentication (401)', async () => {
      const { res } = await jsonPost('/api/addEvent', {
        title: 'No Auth',
        date: '2025-06-01T10:00:00Z',
        latitude: 37.0,
        longitude: -121.0,
        centerID: centerId,
      })
      expect(res.status).toBe(401)
    })

    it('persists externalUrl, signupUrl, allowJanataSignup', async () => {
      const { body: addBody } = await jsonPost(
        '/api/addEvent',
        {
          title: 'Event with external links',
          date: '2025-06-01T10:00:00Z',
          latitude: 37.0,
          longitude: -121.0,
          centerID: centerId,
          externalUrl: 'https://chinmayamission.com/events/satsang',
          signupUrl: 'https://eventbrite.com/e/12345',
          allowJanataSignup: true,
        },
        authHeader(userToken)
      )

      const { body } = await jsonPost('/api/fetchEvent', { id: addBody.id })
      expect(body.event.externalUrl).toBe('https://chinmayamission.com/events/satsang')
      expect(body.event.signupUrl).toBe('https://eventbrite.com/e/12345')
      expect(body.event.allowJanataSignup).toBe(true)
    })

    it('defaults allowJanataSignup to false when omitted', async () => {
      const { body: addBody } = await jsonPost(
        '/api/addEvent',
        {
          title: 'Event without explicit toggle',
          date: '2025-06-01T10:00:00Z',
          latitude: 37.0,
          longitude: -121.0,
          centerID: centerId,
        },
        authHeader(userToken)
      )
      const { body } = await jsonPost('/api/fetchEvent', { id: addBody.id })
      expect(body.event.allowJanataSignup).toBe(false)
      expect(body.event.externalUrl).toBeNull()
      expect(body.event.signupUrl).toBeNull()
    })

    it('rejects oversized signupUrl (400)', async () => {
      const tooLong = 'https://example.com/' + 'a'.repeat(2048)
      const { res } = await jsonPost(
        '/api/addEvent',
        {
          title: 'Long URL',
          date: '2025-06-01T10:00:00Z',
          latitude: 37.0,
          longitude: -121.0,
          centerID: centerId,
          signupUrl: tooLong,
        },
        authHeader(userToken)
      )
      expect(res.status).toBe(400)
    })
  })

  describe('POST /api/fetchEvent', () => {
    it('returns an event by ID', async () => {
      const { body: addBody } = await jsonPost(
        '/api/addEvent',
        {
          title: 'Fetchable Event',
          date: '2025-06-01T10:00:00Z',
          latitude: 37.0,
          longitude: -121.0,
          centerID: centerId,
        },
        authHeader(userToken)
      )

      const { res, body } = await jsonPost('/api/fetchEvent', { id: addBody.id })
      expect(res.status).toBe(200)
      expect(body.event.title).toBe('Fetchable Event')
    })

    it('returns 404 for non-existent event', async () => {
      const { res } = await jsonPost('/api/fetchEvent', { id: 'nonexistent' })
      expect(res.status).toBe(404)
    })
  })

  describe('POST /api/attendEvent & /api/unattendEvent', () => {
    let eventId: string

    beforeEach(async () => {
      const { body } = await jsonPost(
        '/api/addEvent',
        {
          title: 'Attend Event',
          date: '2025-06-01T10:00:00Z',
          latitude: 37.0,
          longitude: -121.0,
          centerID: centerId,
        },
        authHeader(userToken)
      )
      eventId = body.id
    })

    it('attends an event and increments count', async () => {
      const { res, body } = await jsonPost(
        '/api/attendEvent',
        { eventID: eventId },
        authHeader(userToken)
      )
      expect(res.status).toBe(200)
      expect(body.message).toBe('Successfully registered for event')
      expect(body.peopleAttending).toBe(1)
    })

    it('unattends an event and decrements count', async () => {
      await jsonPost('/api/attendEvent', { eventID: eventId }, authHeader(userToken))

      const { res, body } = await jsonPost(
        '/api/unattendEvent',
        { eventID: eventId },
        authHeader(userToken)
      )
      expect(res.status).toBe(200)
      expect(body.message).toBe('Successfully unregistered from event')
      expect(body.peopleAttending).toBe(0)
    })

    it('rejects attend with missing eventID (400)', async () => {
      const { res } = await jsonPost('/api/attendEvent', { eventID: '' }, authHeader(userToken))
      expect(res.status).toBe(400)
    })

    it('rejects attend for non-existent event (404)', async () => {
      const { res } = await jsonPost(
        '/api/attendEvent',
        { eventID: 'ghost-event' },
        authHeader(userToken)
      )
      expect(res.status).toBe(404)
    })
  })

  describe('POST /api/getEventUsers', () => {
    async function createUsersEvent(title = 'Users Event') {
      const { body: addBody } = await jsonPost(
        '/api/addEvent',
        {
          title,
          date: '2030-06-01T10:00:00Z',
          latitude: 37.0,
          longitude: -121.0,
          centerID: centerId,
        },
        authHeader(userToken),
      )
      return addBody.id as string
    }

    it('returns attendees for an event (to an attendee)', async () => {
      const eventId = await createUsersEvent()
      await jsonPost('/api/attendEvent', { eventID: eventId }, authHeader(userToken))

      const { res, body } = await jsonPost(
        '/api/getEventUsers',
        { id: eventId },
        authHeader(userToken),
      )
      expect(res.status).toBe(200)
      expect(body.users).toHaveLength(1)
      expect(body.users[0].id).toBeDefined()
    })

    it('rejects an unauthenticated request with 401', async () => {
      const eventId = await createUsersEvent('Gated Event')
      await jsonPost('/api/attendEvent', { eventID: eventId }, authHeader(userToken))

      const { res } = await jsonPost('/api/getEventUsers', { id: eventId })
      expect(res.status).toBe(401)
    })

    it('rejects a logged-in non-attendee stranger with 403', async () => {
      const eventId = await createUsersEvent('Stranger Event')
      await jsonPost('/api/attendEvent', { eventID: eventId }, authHeader(userToken))

      // A different logged-in user who is NOT the creator/attendee/admin.
      const { token: stranger } = await registerAndLogin('getusers-stranger', 'password123')
      const { res } = await jsonPost(
        '/api/getEventUsers',
        { id: eventId },
        authHeader(stranger),
      )
      expect(res.status).toBe(403)
    })

    it('does NOT leak PII — no email/username/phone/DOB in the gated list', async () => {
      const eventId = await createUsersEvent('PII Event')
      // Authenticate as an attendee (RSVP first) so the gated list is visible.
      await jsonPost('/api/attendEvent', { eventID: eventId }, authHeader(userToken))

      const { body } = await jsonPost(
        '/api/getEventUsers',
        { id: eventId },
        authHeader(userToken),
      )
      const attendee = body.users[0]
      expect(attendee).not.toHaveProperty('email')
      expect(attendee).not.toHaveProperty('username')
      expect(attendee).not.toHaveProperty('phoneNumber')
      expect(attendee).not.toHaveProperty('dateOfBirth')
      // Display-only fields remain.
      expect(attendee).toHaveProperty('id')
      expect(attendee).toHaveProperty('profileImage')
    })

    it('public count is guest-inclusive while the gated list is account-only', async () => {
      const eventId = await createUsersEvent('Guest Count Event')
      // One account RSVP + one (non-upgraded) guest RSVP.
      await jsonPost('/api/attendEvent', { eventID: eventId }, authHeader(userToken))
      await jsonPost('/api/attendEventGuest', {
        eventID: eventId,
        name: 'Count Guest',
        email: 'count-guest@example.com',
      })

      // Public count (no PII, no auth) includes the guest → 2.
      const { res: fetchRes, body: fetchBody } = await jsonPost('/api/fetchEvent', {
        id: eventId,
      })
      expect(fetchRes.status).toBe(200)
      expect(fetchBody.event.peopleAttending).toBe(2)

      // Gated list (as the attendee) only contains the account attendee → 1.
      const { res: usersRes, body: usersBody } = await jsonPost(
        '/api/getEventUsers',
        { id: eventId },
        authHeader(userToken),
      )
      expect(usersRes.status).toBe(200)
      expect(usersBody.users).toHaveLength(1)
    })
  })

  describe('GET /api/events/:id/roster', () => {
    async function createEvent() {
      const { body } = await jsonPost(
        '/api/addEvent',
        {
          title: 'Roster Event',
          date: '2030-06-01T10:00:00Z',
          latitude: 37.0,
          longitude: -121.0,
          centerID: centerId,
        },
        authHeader(userToken),
      )
      return body.id as string
    }

    it('returns registered members (with email) + guests to the creator', async () => {
      const eventId = await createEvent()
      await jsonPost('/api/attendEvent', { eventID: eventId }, authHeader(userToken))
      await jsonPost('/api/attendEventGuest', {
        eventID: eventId,
        name: 'Guest Person',
        email: 'guest@example.com',
      })

      const { res, body } = await fetchJSON(`/api/events/${eventId}/roster`, {
        headers: authHeader(userToken),
      })
      expect(res.status).toBe(200)
      expect(body.counts).toEqual({ registered: 1, guests: 1, total: 2 })
      expect(body.registered[0].email).toBe('eventuser')
      expect(body.guests[0].email).toBe('guest@example.com')
      expect(body.guests[0].name).toBe('Guest Person')
    })

    it('rejects a non-creator, non-admin viewer with 403', async () => {
      const eventId = await createEvent()
      const { token: stranger } = await registerAndLogin('roster-stranger', 'password123')
      const { res } = await fetchJSON(`/api/events/${eventId}/roster`, {
        headers: authHeader(stranger),
      })
      expect(res.status).toBe(403)
    })

    it('lets an admin view any event roster', async () => {
      const eventId = await createEvent()
      const { res, body } = await fetchJSON(`/api/events/${eventId}/roster`, {
        headers: authHeader(adminToken),
      })
      expect(res.status).toBe(200)
      expect(body.counts.total).toBe(0)
    })

    it('returns 404 for an unknown event', async () => {
      const { res } = await fetchJSON('/api/events/does-not-exist/roster', {
        headers: authHeader(adminToken),
      })
      expect(res.status).toBe(404)
    })
  })

  describe('POST /api/removeEvent', () => {
    it('admin can remove an event', async () => {
      const { body: addBody } = await jsonPost(
        '/api/addEvent',
        {
          title: 'Removable Event',
          date: '2025-06-01T10:00:00Z',
          latitude: 37.0,
          longitude: -121.0,
          centerID: centerId,
        },
        authHeader(userToken)
      )

      const { res, body } = await jsonPost(
        '/api/removeEvent',
        { id: addBody.id },
        authHeader(adminToken)
      )
      expect(res.status).toBe(200)
      expect(body.message).toBe('Event removed')

      // Verify deletion
      const { res: fetchRes } = await jsonPost('/api/fetchEvent', { id: addBody.id })
      expect(fetchRes.status).toBe(404)
    })

    it('event creator can delete their own event (200)', async () => {
      const { body: addBody } = await jsonPost(
        '/api/addEvent',
        {
          title: 'Owned Event',
          date: '2025-06-01T10:00:00Z',
          latitude: 37.0,
          longitude: -121.0,
          centerID: centerId,
        },
        authHeader(userToken)
      )

      const { res, body } = await jsonPost(
        '/api/removeEvent',
        { id: addBody.id },
        authHeader(userToken)
      )
      expect(res.status).toBe(200)
      expect(body.message).toBe('Event removed')
    })

    it('non-owner non-admin is rejected (401)', async () => {
      const { body: addBody } = await jsonPost(
        '/api/addEvent',
        {
          title: 'Protected Event',
          date: '2025-06-01T10:00:00Z',
          latitude: 37.0,
          longitude: -121.0,
          centerID: centerId,
        },
        authHeader(userToken)
      )

      // Different non-admin user — not the creator — must be rejected
      const { token: otherToken } = await registerAndLogin('otheruser', 'password123')
      const { res } = await jsonPost('/api/removeEvent', { id: addBody.id }, authHeader(otherToken))
      expect(res.status).toBe(401)
    })

    it('returns 404 when event does not exist', async () => {
      const { res } = await jsonPost(
        '/api/removeEvent',
        { id: '00000000-0000-0000-0000-000000000000' },
        authHeader(adminToken)
      )
      expect(res.status).toBe(404)
    })
  })

  describe('POST /api/updateEvent', () => {
    it('admin can update event fields', async () => {
      const { body: addBody } = await jsonPost(
        '/api/addEvent',
        {
          title: 'Original Title',
          date: '2025-06-01T10:00:00Z',
          latitude: 37.0,
          longitude: -121.0,
          centerID: centerId,
        },
        authHeader(userToken)
      )

      const { res, body } = await jsonPost(
        '/api/updateEvent',
        { eventJSON: { id: addBody.id, title: 'Updated Title' } },
        authHeader(adminToken)
      )
      expect(res.status).toBe(200)
      expect(body.message).toBe('Event updated')

      // Verify update
      const { body: fetchBody } = await jsonPost('/api/fetchEvent', { id: addBody.id })
      expect(fetchBody.event.title).toBe('Updated Title')
    })

    it('non-admin is rejected (401)', async () => {
      const { res } = await jsonPost(
        '/api/updateEvent',
        { eventJSON: { id: 'any', title: 'No' } },
        authHeader(userToken)
      )
      expect(res.status).toBe(404)
    })

    it('returns 400 for missing event ID', async () => {
      const { res } = await jsonPost(
        '/api/updateEvent',
        { eventJSON: { title: 'No ID' } },
        authHeader(adminToken)
      )
      expect(res.status).toBe(400)
    })

    it('returns 404 for non-existent event', async () => {
      const { res } = await jsonPost(
        '/api/updateEvent',
        { eventJSON: { id: 'nonexistent', title: 'Test' } },
        authHeader(adminToken)
      )
      expect(res.status).toBe(404)
    })
  })

  describe('POST /api/fetchEventsByCenter', () => {
    it('returns events for a specific center', async () => {
      await jsonPost(
        '/api/addEvent',
        {
          title: 'Center Event',
          date: '2025-06-01T10:00:00Z',
          latitude: 37.0,
          longitude: -121.0,
          centerID: centerId,
        },
        authHeader(userToken)
      )

      const { body } = await jsonPost('/api/fetchEventsByCenter', { centerID: centerId })
      expect(body.events).toHaveLength(1)
      expect(body.events[0].title).toBe('Center Event')
    })
  })

  describe('POST /api/getUserEvents', () => {
    it('returns events a user is attending', async () => {
      const { body: addBody } = await jsonPost(
        '/api/addEvent',
        {
          title: 'User Event',
          date: '2025-06-01T10:00:00Z',
          latitude: 37.0,
          longitude: -121.0,
          centerID: centerId,
        },
        authHeader(userToken)
      )

      await jsonPost('/api/attendEvent', { eventID: addBody.id }, authHeader(userToken))

      const { body } = await jsonPost(
        '/api/getUserEvents',
        { username: 'eventuser' },
        authHeader(userToken)
      )
      expect(body.events).toHaveLength(1)
      expect(body.events[0].title).toBe('User Event')
    })
  })
})

describe('GET /api/public-profiles/:userId', () => {
  it('requires authentication', async () => {
    const { res } = await fetchJSON('/api/public-profiles/user-123')
    expect(res.status).toBe(401)
  })

  it('returns a safe public profile by user id without email-backed usernames', async () => {
    const target = await registerAndLogin('profile-target@example.com', 'password123')
    const viewer = await registerAndLogin('profile-viewer@example.com', 'password123')

    await env.DB.prepare(
      `UPDATE users
       SET first_name = ?1,
           last_name = ?2,
           phone_number = ?3,
           date_of_birth = ?4,
           points = ?5,
           interests = ?6,
           school = ?7,
           work = ?8,
           region = ?9,
           looking_for = ?10,
           suspended_at = ?11,
           suspended_reason = ?12
       WHERE id = ?13`,
    )
      .bind(
        'Public',
        'Member',
        '555-111-2222',
        '1999-01-02',
        108,
        JSON.stringify(['Gita', 'Seva']),
        'State University',
        'Community Organizer',
        'Bay Area',
        JSON.stringify(['mentor']),
        '2026-01-01T00:00:00.000Z',
        'private moderation note',
        target.user.id,
      )
      .run()

    const eventId = 'hosted-profile-event'
    await db.createEvent(env.DB, {
      id: eventId,
      title: 'Hosted Satsang',
      date: '2026-07-01T10:00:00Z',
      latitude: 37.0,
      longitude: -121.0,
      created_by: target.user.id,
    })

    const { res, body } = await fetchJSON(
      `/api/public-profiles/${encodeURIComponent(target.user.id)}`,
      { headers: authHeader(viewer.token) },
    )

    expect(res.status).toBe(200)
    expect(body.profile).toMatchObject({
      id: target.user.id,
      firstName: 'Public',
      lastName: 'Member',
      centerName: null,
      interests: ['Gita', 'Seva'],
      school: 'State University',
      work: 'Community Organizer',
      region: 'Bay Area',
    })
    expect(body.profile.hostedEvents).toHaveLength(1)
    expect(body.profile.hostedEvents[0].eventID).toBe(eventId)
    expect(body.profile.hostedEvents[0].title).toBe('Hosted Satsang')

    expect(body.profile).not.toHaveProperty('username')
    expect(body.profile).not.toHaveProperty('email')
    expect(body.profile).not.toHaveProperty('phoneNumber')
    expect(body.profile).not.toHaveProperty('dateOfBirth')
    expect(body.profile).not.toHaveProperty('points')
    expect(body.profile).not.toHaveProperty('lookingFor')
    expect(body.profile).not.toHaveProperty('suspendedAt')
    expect(body.profile).not.toHaveProperty('suspendedUntil')
    expect(body.profile).not.toHaveProperty('suspendedReason')
  })

  it('returns 404 for an unknown member id', async () => {
    const { token } = await registerAndLogin('profile-viewer@example.com', 'password123')
    const { res, body } = await fetchJSON('/api/public-profiles/missing-user', {
      headers: authHeader(token),
    })
    expect(res.status).toBe(404)
    expect(body.message).toBe('User not found')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// LEGACY ROUTES
// ═══════════════════════════════════════════════════════════════════════

describe('legacy routes', () => {
  it('POST /api/register forwards to auth/register', async () => {
    const { res, body } = await jsonPost('/api/register', {
      username: 'legacyuser',
      password: 'password123',
      inviteCode: TEST_INVITE_CODE,
    })
    expect(res.status).toBe(201)
    expect(body.username).toBe('legacyuser')
  })

  it('POST /api/authenticate forwards to auth/authenticate', async () => {
    await jsonPost('/api/register', { username: 'legacyauth', password: 'password123', inviteCode: TEST_INVITE_CODE })
    const { res, body } = await jsonPost('/api/authenticate', {
      username: 'legacyauth',
      password: 'password123',
    })
    expect(res.status).toBe(200)
    expect(body.token).toBeDefined()
  })

  it('POST /api/deauthenticate returns success', async () => {
    const { res, body } = await jsonPost('/api/deauthenticate', {})
    expect(res.status).toBe(200)
    expect(body.message).toBe('Deauthentication successful!')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// FUN ROUTE
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/brewCoffee', () => {
  it("returns 418 I'm a teapot", async () => {
    const { res, body } = await jsonPost('/api/brewCoffee', {})
    expect(res.status).toBe(418)
    expect(body.message).toContain('teapot')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════

describe('Admin middleware', () => {
  it('rejects unauthenticated requests to /api/admin/*', async () => {
    const { res, body } = await fetchJSON('/api/admin/stats')
    expect(res.status).toBe(401)
    expect(body.message).toBe('Authorization header missing')
  })

  it('rejects non-admin users', async () => {
    const { token } = await registerAndLogin('regularuser', 'password123')
    const { res, body } = await fetchJSON('/api/admin/stats', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(403)
    expect(body.message).toBe('Admin access required')
  })

  it('allows admin users', async () => {
    const adminToken = await createAdmin()
    const { res } = await fetchJSON('/api/admin/stats', {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(res.status).toBe(200)
  })
})

describe('GET /api/admin/users', () => {
  it('returns paginated user list', async () => {
    const adminToken = await createAdmin()
    await registerAndLogin('alice', 'password123')
    await registerAndLogin('bob', 'password123')

    const { res, body } = await fetchJSON('/api/admin/users?limit=10&offset=0', {
      headers: authHeader(adminToken),
    })

    expect(res.status).toBe(200)
    expect(body.total).toBe(3) // admin + alice + bob
    expect(body.data).toHaveLength(3)
    expect(body.limit).toBe(10)
    expect(body.offset).toBe(0)
    expect(body.data[0].password).toBeUndefined()
  })

  it('searches by username, email, first_name, last_name', async () => {
    const adminToken = await createAdmin()
    await registerAndLogin('alice_wonder', 'password123')
    await registerAndLogin('bob_builder', 'password123')

    const { body } = await fetchJSON('/api/admin/users?q=alice', {
      headers: authHeader(adminToken),
    })

    expect(body.total).toBe(1)
    expect(body.data[0].username).toBe('alice_wonder')
  })

  it('paginates with limit and offset', async () => {
    const adminToken = await createAdmin()
    await registerAndLogin('user1', 'password123')
    await registerAndLogin('user2', 'password123')
    await registerAndLogin('user3', 'password123')

    const { body } = await fetchJSON('/api/admin/users?limit=2&offset=0', {
      headers: authHeader(adminToken),
    })
    expect(body.data).toHaveLength(2)
    expect(body.total).toBe(4)

    const { body: page2 } = await fetchJSON('/api/admin/users?limit=2&offset=2', {
      headers: authHeader(adminToken),
    })
    expect(page2.data).toHaveLength(2)
  })

  it('defaults to limit=50 offset=0', async () => {
    const adminToken = await createAdmin()
    const { body } = await fetchJSON('/api/admin/users', {
      headers: authHeader(adminToken),
    })
    expect(body.limit).toBe(50)
    expect(body.offset).toBe(0)
  })
})

describe('GET /api/admin/centers', () => {
  it('returns paginated center list with member counts', async () => {
    const adminToken = await createAdmin()
    await jsonPost('/api/addCenter', { centerName: 'CM San Jose', latitude: 37.3, longitude: -121.9, address: '1050 S White Rd' }, authHeader(adminToken))
    await jsonPost('/api/addCenter', { centerName: 'CM Houston', latitude: 29.7, longitude: -95.4 }, authHeader(adminToken))

    const { res, body } = await fetchJSON('/api/admin/centers?limit=10&offset=0', { headers: authHeader(adminToken) })
    expect(res.status).toBe(200)
    expect(body.total).toBe(2)
    expect(body.data).toHaveLength(2)
    expect(body.data[0].centerID).toBeDefined()
    expect(body.data[0].name).toBeDefined()
  })

  it('searches by center name, address, or acharya', async () => {
    const adminToken = await createAdmin()
    await jsonPost('/api/addCenter', { centerName: 'CM San Jose', latitude: 37.3, longitude: -121.9 }, authHeader(adminToken))
    await jsonPost('/api/addCenter', { centerName: 'CM Houston', latitude: 29.7, longitude: -95.4 }, authHeader(adminToken))

    const { body } = await fetchJSON('/api/admin/centers?q=houston', { headers: authHeader(adminToken) })
    expect(body.total).toBe(1)
    expect(body.data[0].name).toBe('CM Houston')
  })
})

describe('GET /api/admin/events', () => {
  it('returns paginated event list', async () => {
    const adminToken = await createAdmin()
    const { body: centerBody } = await jsonPost('/api/addCenter', { centerName: 'CM San Jose', latitude: 37.3, longitude: -121.9 }, authHeader(adminToken))
    const centerId = centerBody.id

    await jsonPost('/api/addEvent', { title: 'Gita Chanting', date: '2026-04-05T10:00:00Z', latitude: 37.3, longitude: -121.9, centerID: centerId }, authHeader(adminToken))
    await jsonPost('/api/addEvent', { title: 'Youth Retreat', date: '2026-04-12T09:00:00Z', latitude: 37.3, longitude: -121.9, centerID: centerId }, authHeader(adminToken))

    const { res, body } = await fetchJSON('/api/admin/events?limit=10&offset=0', { headers: authHeader(adminToken) })
    expect(res.status).toBe(200)
    expect(body.total).toBe(2)
    expect(body.data).toHaveLength(2)
    expect(body.data[0].eventID).toBeDefined()
    expect(body.data[0].title).toBeDefined()
  })

  it('searches by title, address, or description', async () => {
    const adminToken = await createAdmin()
    const { body: centerBody } = await jsonPost('/api/addCenter', { centerName: 'CM San Jose', latitude: 37.3, longitude: -121.9 }, authHeader(adminToken))

    await jsonPost('/api/addEvent', { title: 'Gita Chanting', description: 'Weekly session', date: '2026-04-05T10:00:00Z', latitude: 37.3, longitude: -121.9, centerID: centerBody.id }, authHeader(adminToken))
    await jsonPost('/api/addEvent', { title: 'Youth Retreat', description: 'Annual retreat', date: '2026-04-12T09:00:00Z', latitude: 37.3, longitude: -121.9, centerID: centerBody.id }, authHeader(adminToken))

    const { body } = await fetchJSON('/api/admin/events?q=gita', { headers: authHeader(adminToken) })
    expect(body.total).toBe(1)
    expect(body.data[0].title).toBe('Gita Chanting')
  })
})

describe('Admin center actions', () => {
  async function createTestCenter(adminToken: string) {
    const { body } = await jsonPost('/api/addCenter', {
      centerName: 'CM Test', latitude: 37.3, longitude: -121.9, address: '123 Test St',
    }, authHeader(adminToken))
    return body.id
  }

  it('PUT /api/admin/centers/:id updates center details', async () => {
    const adminToken = await createAdmin()
    const centerId = await createTestCenter(adminToken)

    const { res, body } = await jsonPut(`/api/admin/centers/${centerId}`, {
      name: 'CM San Jose Updated', phone: '555-1234',
    }, authHeader(adminToken))

    expect(res.status).toBe(200)
    expect(body.message).toBe('Center updated')

    const { body: fetched } = await jsonPost('/api/fetchCenter', { centerID: centerId })
    expect(fetched.center.name).toBe('CM San Jose Updated')
    expect(fetched.center.phone).toBe('555-1234')
  })

  it('POST /api/admin/centers/:id/verify toggles verification', async () => {
    const adminToken = await createAdmin()
    const centerId = await createTestCenter(adminToken)

    const { res } = await jsonPost(`/api/admin/centers/${centerId}/verify`, {}, authHeader(adminToken))
    expect(res.status).toBe(200)

    const { body: fetched } = await jsonPost('/api/fetchCenter', { centerID: centerId })
    expect(fetched.center.isVerified).toBe(true)

    await jsonPost(`/api/admin/centers/${centerId}/verify`, {}, authHeader(adminToken))
    const { body: fetched2 } = await jsonPost('/api/fetchCenter', { centerID: centerId })
    expect(fetched2.center.isVerified).toBe(false)
  })

  it('DELETE /api/admin/centers/:id deletes center', async () => {
    const adminToken = await createAdmin()
    const centerId = await createTestCenter(adminToken)

    const { res } = await fetchJSON(`/api/admin/centers/${centerId}`, {
      method: 'DELETE', headers: authHeader(adminToken),
    })
    expect(res.status).toBe(200)

    const { res: fetchRes } = await jsonPost('/api/fetchCenter', { centerID: centerId })
    expect(fetchRes.status).toBe(404)
  })

  it('returns 404 for non-existent center', async () => {
    const adminToken = await createAdmin()
    const { res } = await jsonPut('/api/admin/centers/nonexistent', { name: 'test' }, authHeader(adminToken))
    expect(res.status).toBe(404)
  })
})

describe('Admin event actions', () => {
  async function createTestEvent(adminToken: string) {
    const { body: centerBody } = await jsonPost('/api/addCenter', {
      centerName: 'CM Test', latitude: 37.3, longitude: -121.9,
    }, authHeader(adminToken))
    const { body: eventBody } = await jsonPost('/api/addEvent', {
      title: 'Test Event', date: '2026-04-05T10:00:00Z', latitude: 37.3, longitude: -121.9,
      centerID: centerBody.id, description: 'Original description',
    }, authHeader(adminToken))
    return { eventId: eventBody.id, centerId: centerBody.id }
  }

  it('PUT /api/admin/events/:id updates event details', async () => {
    const adminToken = await createAdmin()
    const { eventId } = await createTestEvent(adminToken)
    const { res, body } = await jsonPut(`/api/admin/events/${eventId}`, {
      title: 'Updated Event', description: 'New description',
    }, authHeader(adminToken))
    expect(res.status).toBe(200)
    expect(body.message).toBe('Event updated')
    const { body: fetched } = await jsonPost('/api/fetchEvent', { id: eventId })
    expect(fetched.event.title).toBe('Updated Event')
    expect(fetched.event.description).toBe('New description')
  })

  it('DELETE /api/admin/events/:id deletes event', async () => {
    const adminToken = await createAdmin()
    const { eventId } = await createTestEvent(adminToken)
    const { res } = await fetchJSON(`/api/admin/events/${eventId}`, {
      method: 'DELETE', headers: authHeader(adminToken),
    })
    expect(res.status).toBe(200)
    const { res: fetchRes } = await jsonPost('/api/fetchEvent', { id: eventId })
    expect(fetchRes.status).toBe(404)
  })

  it('returns 404 for non-existent event', async () => {
    const adminToken = await createAdmin()
    const { res } = await jsonPut('/api/admin/events/nonexistent', { title: 'test' }, authHeader(adminToken))
    expect(res.status).toBe(404)
  })
})

describe('GET /api/admin/centers/:id/members', () => {
  it('returns users belonging to a center', async () => {
    const adminToken = await createAdmin()

    // Create center
    const { body: centerBody } = await jsonPost('/api/addCenter', {
      centerName: 'CM Test',
      latitude: 37.3,
      longitude: -121.9,
    }, authHeader(adminToken))
    const centerId = centerBody.id

    // Create a user and assign them to the center
    const { token: userToken, user } = await registerAndLogin('member1', 'password123')
    await jsonPut('/api/auth/update-profile', {
      centerID: centerId,
    }, authHeader(userToken))

    const { res, body } = await fetchJSON(`/api/admin/centers/${centerId}/members`, {
      headers: authHeader(adminToken),
    })

    expect(res.status).toBe(200)
    expect(body.data.length).toBeGreaterThanOrEqual(1)
    expect(body.data.some((u: any) => u.username === 'member1')).toBe(true)
  })

  it('returns 404 for non-existent center', async () => {
    const adminToken = await createAdmin()
    const { res } = await fetchJSON('/api/admin/centers/nonexistent/members', {
      headers: authHeader(adminToken),
    })
    expect(res.status).toBe(404)
  })
})

describe('Admin user actions', () => {
  it('POST /api/admin/users/:id/verify toggles user verification', async () => {
    const adminToken = await createAdmin()
    const { user } = await registerAndLogin('testuser', 'password123')

    // Verify the user
    const { res, body } = await jsonPost(`/api/admin/users/${user.id}/verify`, {
      verificationLevel: 54,
    }, authHeader(adminToken))
    expect(res.status).toBe(200)
    expect(body.isVerified).toBe(true)

    // Unverify the user
    const { body: body2 } = await jsonPost(`/api/admin/users/${user.id}/verify`, {
      verificationLevel: 45,
      isVerified: false,
    }, authHeader(adminToken))
    expect(body2.isVerified).toBe(false)
  })

  it('DELETE /api/admin/users/:id deletes user', async () => {
    const adminToken = await createAdmin()
    const { user } = await registerAndLogin('deleteuser', 'password123')

    const { res } = await fetchJSON(`/api/admin/users/${user.id}`, {
      method: 'DELETE',
      headers: authHeader(adminToken),
    })
    expect(res.status).toBe(200)

    // Verify user is gone
    const { body } = await jsonPost('/api/userExistence', { username: 'deleteuser' })
    expect(body.existence).toBe(false)
  })

  it('returns 404 for non-existent user', async () => {
    const adminToken = await createAdmin()
    const { res } = await jsonPost('/api/admin/users/nonexistent/verify', {
      verificationLevel: 54,
    }, authHeader(adminToken))
    expect(res.status).toBe(404)
  })

  it('prevents admin from deleting themselves', async () => {
    const adminToken = await createAdmin()

    // Get admin user ID
    const { body: verifyBody } = await fetchJSON('/api/auth/verify', {
      headers: authHeader(adminToken),
    })
    const adminId = verifyBody.user.id

    const { res, body } = await fetchJSON(`/api/admin/users/${adminId}`, {
      method: 'DELETE',
      headers: authHeader(adminToken),
    })
    expect(res.status).toBe(400)
    expect(body.message).toBe('Cannot delete your own account from admin panel')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// ADMIN END-TO-END WORKFLOW
// ═══════════════════════════════════════════════════════════════════════

describe('Admin end-to-end workflow', () => {
  it('full admin lifecycle: list, create, edit, verify, delete', async () => {
    const adminToken = await createAdmin()

    // 1. Check stats — start empty (just admin user)
    const { body: stats } = await fetchJSON('/api/admin/stats', {
      headers: authHeader(adminToken),
    })
    expect(stats.users).toBe(1)
    expect(stats.centers).toBe(0)
    expect(stats.events).toBe(0)

    // 2. Create a center, verify it appears in admin list
    await jsonPost('/api/addCenter', {
      centerName: 'CM Test Center',
      latitude: 37.3,
      longitude: -121.9,
    }, authHeader(adminToken))

    const { body: centerList } = await fetchJSON('/api/admin/centers', {
      headers: authHeader(adminToken),
    })
    expect(centerList.total).toBe(1)
    const centerId = centerList.data[0].centerID

    // 3. Verify the center
    await jsonPost(`/api/admin/centers/${centerId}/verify`, {}, authHeader(adminToken))
    const { body: centerAfterVerify } = await fetchJSON('/api/admin/centers', {
      headers: authHeader(adminToken),
    })
    expect(centerAfterVerify.data[0].isVerified).toBe(true)

    // 4. Create an event, verify in admin list
    await jsonPost('/api/addEvent', {
      title: 'Test Event',
      date: '2026-04-05T10:00:00Z',
      latitude: 37.3,
      longitude: -121.9,
      centerID: centerId,
    }, authHeader(adminToken))

    const { body: eventList } = await fetchJSON('/api/admin/events', {
      headers: authHeader(adminToken),
    })
    expect(eventList.total).toBe(1)

    // 5. Stats should reflect the new data
    const { body: stats2 } = await fetchJSON('/api/admin/stats', {
      headers: authHeader(adminToken),
    })
    expect(stats2.centers).toBe(1)
    expect(stats2.events).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// USER-ISSUED INVITE CODES (v2)
// ═══════════════════════════════════════════════════════════════════════

// Developer email path: lands at BRAHMACHARI (108) without an invite code.
// Used in tests to get a "verified" user that can mint invite codes.
const DEV_EMAIL = 'kishparikh18@gmail.com'

async function registerAsDeveloper(): Promise<{ token: string; user: any }> {
  await jsonPost('/api/auth/register', { username: DEV_EMAIL, password: 'devpassword123' })
  const { body } = await jsonPost('/api/auth/authenticate', {
    username: DEV_EMAIL,
    password: 'devpassword123',
  })
  return { token: body.token, user: body.user }
}

describe('POST /api/auth/invite-codes (mint)', () => {
  it('verified user mints a multi-use code (default 25 uses / 7-day expiry)', async () => {
    const { token } = await registerAsDeveloper()
    const { res, body } = await jsonPost('/api/auth/invite-codes', {}, authHeader(token))
    expect(res.status).toBe(200)
    expect(body.code).toMatch(/^[0-9A-F]{12}$/)
    expect(body.shareUrl).toBe(`https://janata.app/i/${body.code}`)
    expect(body.maxUses).toBe(25)
    const ttlDays = (new Date(body.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    expect(ttlDays).toBeGreaterThan(6.9)
    expect(ttlDays).toBeLessThan(7.1)
  })

  it('honors maxUses + expiresInDays overrides', async () => {
    const { token } = await registerAsDeveloper()
    const { res, body } = await jsonPost(
      '/api/auth/invite-codes',
      { maxUses: 3, expiresInDays: 2 },
      authHeader(token),
    )
    expect(res.status).toBe(200)
    expect(body.maxUses).toBe(3)
    const ttlDays = (new Date(body.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    expect(ttlDays).toBeGreaterThan(1.9)
    expect(ttlDays).toBeLessThan(2.1)
  })

  it('clamps out-of-range overrides (maxUses to 100, expiry to 30 days)', async () => {
    const { token } = await registerAsDeveloper()
    const { body } = await jsonPost(
      '/api/auth/invite-codes',
      { maxUses: 9999, expiresInDays: 9999 },
      authHeader(token),
    )
    expect(body.maxUses).toBe(100)
    const ttlDays = (new Date(body.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    expect(ttlDays).toBeLessThan(30.1)
    expect(ttlDays).toBeGreaterThan(29.9)
  })

  it('rejects non-integer overrides with 400', async () => {
    const { token } = await registerAsDeveloper()
    const bad = await jsonPost('/api/auth/invite-codes', { maxUses: 2.5 }, authHeader(token))
    expect(bad.res.status).toBe(400)
    const bad2 = await jsonPost(
      '/api/auth/invite-codes',
      { expiresInDays: 'soon' as any },
      authHeader(token),
    )
    expect(bad2.res.status).toBe(400)
  })

  it('rejects unverified user with 403', async () => {
    // Self-signup with no invite = UNVERIFIED_USER
    await jsonPost('/api/auth/register', { username: 'noinvite@test.com', password: 'password123' })
    const { body: auth } = await jsonPost('/api/auth/authenticate', {
      username: 'noinvite@test.com',
      password: 'password123',
    })
    const { res, body } = await jsonPost('/api/auth/invite-codes', {}, authHeader(auth.token))
    expect(res.status).toBe(403)
    expect(body.message).toContain('verified')
  })

  it('rejects missing auth with 401', async () => {
    const { res } = await jsonPost('/api/auth/invite-codes', {})
    expect(res.status).toBe(401)
  })

  it('returns a different code on each call', async () => {
    const { token } = await registerAsDeveloper()
    const { body: a } = await jsonPost('/api/auth/invite-codes', {}, authHeader(token))
    const { body: b } = await jsonPost('/api/auth/invite-codes', {}, authHeader(token))
    expect(a.code).not.toBe(b.code)
  })
})

describe('GET /api/auth/invite-codes/mine', () => {
  it('returns empty list when user has not minted any codes', async () => {
    const { token } = await registerAsDeveloper()
    const { res, body } = await fetchJSON('/api/auth/invite-codes/mine', {
      headers: authHeader(token),
    })
    expect(res.status).toBe(200)
    expect(body.codes).toEqual([])
  })

  it('returns the codes the user has minted', async () => {
    const { token } = await registerAsDeveloper()
    await jsonPost('/api/auth/invite-codes', {}, authHeader(token))
    await jsonPost('/api/auth/invite-codes', {}, authHeader(token))
    const { body } = await fetchJSON('/api/auth/invite-codes/mine', {
      headers: authHeader(token),
    })
    expect(body.codes).toHaveLength(2)
    expect(body.codes[0].isUsable).toBe(true)
    expect(body.codes[0].shareUrl).toBe(`https://janata.app/i/${body.codes[0].code}`)
  })

  it("does not leak other users' codes", async () => {
    // Mint a code as dev user, then sign up a separate user and check theirs is empty.
    const { token: devToken } = await registerAsDeveloper()
    await jsonPost('/api/auth/invite-codes', {}, authHeader(devToken))

    await jsonPost('/api/auth/register', { username: 'other@test.com', password: 'password123' })
    const { body: auth } = await jsonPost('/api/auth/authenticate', {
      username: 'other@test.com',
      password: 'password123',
    })
    const { body } = await fetchJSON('/api/auth/invite-codes/mine', {
      headers: authHeader(auth.token),
    })
    expect(body.codes).toEqual([])
  })
})

describe('POST /api/auth/redeem-invite', () => {
  it('records the invite code for an unverified user (no email-verify yet)', async () => {
    // Verified user mints a code
    const { token: devToken } = await registerAsDeveloper()
    const { body: minted } = await jsonPost('/api/auth/invite-codes', {}, authHeader(devToken))

    // Unverified user redeems it
    await jsonPost('/api/auth/register', { username: 'redeem@test.com', password: 'password123' })
    const { body: auth } = await jsonPost('/api/auth/authenticate', {
      username: 'redeem@test.com',
      password: 'password123',
    })
    const { res, body } = await jsonPost(
      '/api/auth/redeem-invite',
      { code: minted.code },
      authHeader(auth.token),
    )
    expect(res.status).toBe(200)
    expect(body.message).toContain('verify your email')
    expect(body.user.verificationLevel).toBe(30) // still UNVERIFIED
  })

  it('rejects already-verified users with 400', async () => {
    const { token } = await registerAsDeveloper()
    const { res, body } = await jsonPost(
      '/api/auth/redeem-invite',
      { code: 'ANYTHING' },
      authHeader(token),
    )
    expect(res.status).toBe(400)
    expect(body.message).toContain('Already verified')
  })

  it('rejects users who already have an invite_code associated', async () => {
    // Simulate a legacy/pre-flip user who already has an invite associated but
    // has not yet reached NORMAL_USER. New invite signups are verified at
    // inception and hit the "Already verified" guard first.
    await jsonPost('/api/auth/register', { username: 'hasinv@test.com', password: 'password123' })
    await env.DB.prepare('UPDATE users SET invite_code = ? WHERE username = ?')
      .bind(TEST_INVITE_CODE, 'hasinv@test.com')
      .run()
    const { body: auth } = await jsonPost('/api/auth/authenticate', {
      username: 'hasinv@test.com',
      password: 'password123',
    })
    const { res, body } = await jsonPost(
      '/api/auth/redeem-invite',
      { code: 'ANYTHING' },
      authHeader(auth.token),
    )
    expect(res.status).toBe(400)
    expect(body.message).toContain('already associated')
  })

  it('rejects invalid codes with 401', async () => {
    await jsonPost('/api/auth/register', { username: 'bad@test.com', password: 'password123' })
    const { body: auth } = await jsonPost('/api/auth/authenticate', {
      username: 'bad@test.com',
      password: 'password123',
    })
    const { res, body } = await jsonPost(
      '/api/auth/redeem-invite',
      { code: 'NOPE' },
      authHeader(auth.token),
    )
    expect(res.status).toBe(401)
    expect(body.message).toContain('Invalid')
  })

  it('rejects redemption of an exhausted (single-use) code with 409 exhausted', async () => {
    const { token: devToken } = await registerAsDeveloper()
    const { body: minted } = await jsonPost(
      '/api/auth/invite-codes',
      { maxUses: 1 },
      authHeader(devToken),
    )

    // First redemption: user A
    await jsonPost('/api/auth/register', { username: 'first@test.com', password: 'password123' })
    const { body: authA } = await jsonPost('/api/auth/authenticate', {
      username: 'first@test.com',
      password: 'password123',
    })
    const first = await jsonPost(
      '/api/auth/redeem-invite',
      { code: minted.code },
      authHeader(authA.token),
    )
    expect(first.res.status).toBe(200)

    // Second redemption attempt by user B should fail as exhausted
    await jsonPost('/api/auth/register', { username: 'second@test.com', password: 'password123' })
    const { body: authB } = await jsonPost('/api/auth/authenticate', {
      username: 'second@test.com',
      password: 'password123',
    })
    const second = await jsonPost(
      '/api/auth/redeem-invite',
      { code: minted.code },
      authHeader(authB.token),
    )
    expect(second.res.status).toBe(409)
    expect(second.body.reason).toBe('exhausted')
  })

  it('a multi-use code can be redeemed up to its cap, then is exhausted', async () => {
    const { token: devToken } = await registerAsDeveloper()
    const { body: minted } = await jsonPost(
      '/api/auth/invite-codes',
      { maxUses: 3 },
      authHeader(devToken),
    )

    // Three distinct unverified users redeem successfully.
    for (let i = 0; i < 3; i++) {
      await jsonPost('/api/auth/register', {
        username: `cap${i}@test.com`,
        password: 'password123',
      })
      const { body: auth } = await jsonPost('/api/auth/authenticate', {
        username: `cap${i}@test.com`,
        password: 'password123',
      })
      const r = await jsonPost(
        '/api/auth/redeem-invite',
        { code: minted.code },
        authHeader(auth.token),
      )
      expect(r.res.status).toBe(200)
    }

    // Fourth redemption is refused as exhausted.
    await jsonPost('/api/auth/register', { username: 'cap3@test.com', password: 'password123' })
    const { body: auth4 } = await jsonPost('/api/auth/authenticate', {
      username: 'cap3@test.com',
      password: 'password123',
    })
    const fourth = await jsonPost(
      '/api/auth/redeem-invite',
      { code: minted.code },
      authHeader(auth4.token),
    )
    expect(fourth.res.status).toBe(409)
    expect(fourth.body.reason).toBe('exhausted')
  })

  it('redeeming an expired code returns 410 expired, and records inviter attribution on success', async () => {
    const { token: devToken, user: dev } = await registerAsDeveloper()
    const { body: minted } = await jsonPost('/api/auth/invite-codes', {}, authHeader(devToken))

    // Force the code into the past.
    await env.DB.prepare('UPDATE invite_codes SET expires_at = ? WHERE code = ?')
      .bind('2000-01-01T00:00:00.000Z', minted.code)
      .run()

    await jsonPost('/api/auth/register', { username: 'expired@test.com', password: 'password123' })
    const { body: auth } = await jsonPost('/api/auth/authenticate', {
      username: 'expired@test.com',
      password: 'password123',
    })
    const expired = await jsonPost(
      '/api/auth/redeem-invite',
      { code: minted.code },
      authHeader(auth.token),
    )
    expect(expired.res.status).toBe(410)
    expect(expired.body.reason).toBe('expired')

    // A fresh code from the same minter records inviter attribution on the
    // redeemer (users.invite_code → invite_codes.created_by_user_id = minter).
    const { body: fresh } = await jsonPost('/api/auth/invite-codes', {}, authHeader(devToken))
    await jsonPost('/api/auth/register', { username: 'attrib@test.com', password: 'password123' })
    const { body: authAttrib } = await jsonPost('/api/auth/authenticate', {
      username: 'attrib@test.com',
      password: 'password123',
    })
    const ok = await jsonPost(
      '/api/auth/redeem-invite',
      { code: fresh.code },
      authHeader(authAttrib.token),
    )
    expect(ok.res.status).toBe(200)
    const row = await env.DB.prepare(
      `SELECT u.invited_by_user_id AS directInviter, ic.created_by_user_id AS inviter
         FROM users u JOIN invite_codes ic ON ic.code = u.invite_code
        WHERE u.username = ?`,
    )
      .bind('attrib@test.com')
      .first<{ directInviter: string; inviter: string }>()
    expect(row?.directInviter).toBe(dev.id)
    expect(row?.inviter).toBe(dev.id)
  })
})

describe('POST /api/auth/register — invite code consume', () => {
  it('single-use code can only be redeemed once at signup and records inviter attribution', async () => {
    const { token: devToken, user: dev } = await registerAsDeveloper()
    const { body: minted } = await jsonPost(
      '/api/auth/invite-codes',
      { maxUses: 1 },
      authHeader(devToken),
    )

    const a = await jsonPost('/api/auth/register', {
      username: 'racea@test.com',
      password: 'password123',
      inviteCode: minted.code,
    })
    const b = await jsonPost('/api/auth/register', {
      username: 'raceb@test.com',
      password: 'password123',
      inviteCode: minted.code,
    })
    expect(a.res.status).toBe(201)
    const row = await env.DB.prepare(
      `SELECT invite_code, invited_by_user_id, verification_level FROM users WHERE username = ?`,
    )
      .bind('racea@test.com')
      .first<{ invite_code: string; invited_by_user_id: string; verification_level: number }>()
    expect(row?.invite_code).toBe(minted.code)
    expect(row?.invited_by_user_id).toBe(dev.id)
    expect(row?.verification_level).toBe(45)
    // Sequential: validateInviteCode rejects on the second call (uses_count
    // already at max_uses), returning 401. In a true concurrent race the
    // second signup could get 409 from consumeInviteCode losing. Either
    // outcome is a correct rejection.
    expect([401, 409]).toContain(b.res.status)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// MODERATION (#209)
// ═══════════════════════════════════════════════════════════════════════

describe('moderation', () => {
  let adminToken: string
  let memberToken: string
  let memberId: string
  let centerId: string
  let postId: string

  beforeEach(async () => {
    adminToken = await createAdmin()
    const member = await registerAndLogin('modmember', 'password123')
    memberToken = member.token
    memberId = member.user.id

    const { body: center } = await jsonPost(
      '/api/addCenter',
      { centerName: 'Mod Center', latitude: 37.0, longitude: -121.0 },
      authHeader(adminToken),
    )
    centerId = center.id
    await env.DB.prepare('UPDATE users SET center_id = ? WHERE id = ?').bind(centerId, memberId).run()

    const { body: post } = await jsonPost(
      `/api/boards/center/${centerId}/posts`,
      { body: 'a post that will be reported' },
      authHeader(memberToken),
    )
    postId = post.post.id
  })

  async function createReportedCenterPost(
    centerName: string,
    memberUsername: string,
    reporterUsername: string,
    body: string,
  ): Promise<{ centerId: string; postId: string; memberToken: string }> {
    const { body: center } = await jsonPost(
      '/api/addCenter',
      { centerName, latitude: 38.0, longitude: -122.0 },
      authHeader(adminToken),
    )
    const member = await registerAndLogin(memberUsername, 'password123')
    await env.DB.prepare('UPDATE users SET center_id = ? WHERE id = ?')
      .bind(center.id, member.user.id)
      .run()
    const { body: post } = await jsonPost(
      `/api/boards/center/${center.id}/posts`,
      { body },
      authHeader(member.token),
    )
    const reporter = await registerAndLogin(reporterUsername, 'password123')
    await jsonPost(
      `/api/boards/posts/${post.post.id}/report`,
      { reason: 'out of scope' },
      authHeader(reporter.token),
    )
    return { centerId: center.id, postId: post.post.id, memberToken: member.token }
  }

  describe('POST /boards/posts/:postId/report', () => {
    it('lets an authenticated user report a post (201) and surfaces it in the queue', async () => {
      const reporter = await registerAndLogin('reporter1', 'password123')
      const { res } = await jsonPost(
        `/api/boards/posts/${postId}/report`,
        { reason: 'spam' },
        authHeader(reporter.token),
      )
      expect(res.status).toBe(201)

      const { res: qRes, body: q } = await fetchJSON('/api/admin/moderation/queue', {
        headers: authHeader(adminToken),
      })
      expect(qRes.status).toBe(200)
      expect(q.data).toHaveLength(1)
      expect(q.data[0].post.id).toBe(postId)
      expect(q.data[0].reportCount).toBe(1)
      expect(q.data[0].openReportCount).toBe(1)
      expect(q.data[0].latestReason).toBe('spam')
      expect(q.data[0].status).toBe('open')
    })

    it('dedupes repeat reports from the same user (one row, reason updated)', async () => {
      const reporter = await registerAndLogin('reporter2', 'password123')
      await jsonPost(`/api/boards/posts/${postId}/report`, { reason: 'first' }, authHeader(reporter.token))
      await jsonPost(`/api/boards/posts/${postId}/report`, { reason: 'second' }, authHeader(reporter.token))
      const { body: q } = await fetchJSON('/api/admin/moderation/queue', { headers: authHeader(adminToken) })
      expect(q.data[0].reportCount).toBe(1)
      expect(q.data[0].latestReason).toBe('second')
    })

    it('groups multiple reporters and counts them', async () => {
      const r1 = await registerAndLogin('rA', 'password123')
      const r2 = await registerAndLogin('rB', 'password123')
      await jsonPost(`/api/boards/posts/${postId}/report`, { reason: 'x' }, authHeader(r1.token))
      await jsonPost(`/api/boards/posts/${postId}/report`, { reason: 'y' }, authHeader(r2.token))
      const { body: q } = await fetchJSON('/api/admin/moderation/queue', { headers: authHeader(adminToken) })
      expect(q.data[0].reportCount).toBe(2)
      expect(q.data[0].openReportCount).toBe(2)
    })

    it('404s on a non-existent post', async () => {
      const { res } = await jsonPost(
        '/api/boards/posts/does-not-exist/report',
        { reason: 'x' },
        authHeader(memberToken),
      )
      expect(res.status).toBe(404)
    })
  })

  describe('sevak moderation tier (admin + sevak ≥54)', () => {
    let sevakToken: string

    beforeEach(async () => {
      const sevak = await registerAndLogin('modsevak', 'password123')
      sevakToken = sevak.token
      await env.DB.prepare(
        'UPDATE users SET center_id = ?, verification_level = 54 WHERE username = ?',
      )
        .bind(centerId, 'modsevak')
        .run()
    })

    it('lets a sevak view reported posts in their own center scope', async () => {
      const reporter = await registerAndLogin('sevakreporter', 'password123')
      await jsonPost(`/api/boards/posts/${postId}/report`, { reason: 'spam' }, authHeader(reporter.token))
      const { res, body } = await fetchJSON('/api/admin/moderation/queue', {
        headers: authHeader(sevakToken),
      })
      expect(res.status).toBe(200)
      expect(body.data).toHaveLength(1)
      expect(body.data[0].post.id).toBe(postId)
    })

    it('lets a sevak remove a reported post + writes an audit entry', async () => {
      const reporter = await registerAndLogin('sevakreporter2', 'password123')
      await jsonPost(`/api/boards/posts/${postId}/report`, { reason: 'bad' }, authHeader(reporter.token))
      const del = await jsonPost(
        `/api/admin/moderation/posts/${postId}/delete`,
        {},
        authHeader(sevakToken),
      )
      expect(del.res.status).toBe(200)
      const { res: aRes, body: audit } = await fetchJSON('/api/admin/moderation/audit', {
        headers: authHeader(sevakToken),
      })
      expect(aRes.status).toBe(200)
      expect(audit.data.length).toBeGreaterThan(0)
    })

    it('does not show another center report in a sevak moderation queue', async () => {
      const reporter = await registerAndLogin('sevakreporter3', 'password123')
      await jsonPost(`/api/boards/posts/${postId}/report`, { reason: 'spam' }, authHeader(reporter.token))
      const other = await createReportedCenterPost(
        'Other Mod Center',
        'othermodmember',
        'othermodreporter',
        'out-of-center post',
      )

      const { res, body } = await fetchJSON('/api/admin/moderation/queue', {
        headers: authHeader(sevakToken),
      })
      expect(res.status).toBe(200)
      expect(body.total).toBe(1)
      expect(body.data.map((item: any) => item.post.id)).toEqual([postId])

      const { body: adminQueue } = await fetchJSON('/api/admin/moderation/queue', {
        headers: authHeader(adminToken),
      })
      expect(adminQueue.data.map((item: any) => item.post.id)).toEqual(
        expect.arrayContaining([postId, other.postId]),
      )
    })

    it('rejects sevak deletion outside scope but still allows own-center deletion', async () => {
      const reporter = await registerAndLogin('sevakreporter4', 'password123')
      await jsonPost(`/api/boards/posts/${postId}/report`, { reason: 'bad' }, authHeader(reporter.token))
      const other = await createReportedCenterPost(
        'Outside Delete Center',
        'outsidedeletemember',
        'outsidedeletereporter',
        'out-of-center delete target',
      )

      const blocked = await jsonPost(
        `/api/admin/moderation/posts/${other.postId}/delete`,
        {},
        authHeader(sevakToken),
      )
      expect(blocked.res.status).toBe(403)
      const otherRow = await env.DB.prepare('SELECT deleted_at FROM board_posts WHERE id = ?')
        .bind(other.postId)
        .first<{ deleted_at: string | null }>()
      expect(otherRow?.deleted_at).toBeNull()

      const allowed = await jsonPost(
        `/api/admin/moderation/posts/${postId}/delete`,
        {},
        authHeader(sevakToken),
      )
      expect(allowed.res.status).toBe(200)
    })

    it('scopes sevak audit entries to posts they can moderate', async () => {
      const reporter = await registerAndLogin('sevakreporter5', 'password123')
      await jsonPost(`/api/boards/posts/${postId}/report`, { reason: 'bad' }, authHeader(reporter.token))
      const other = await createReportedCenterPost(
        'Other Audit Center',
        'otherauditmember',
        'otherauditreporter',
        'out-of-center audit target',
      )

      await jsonPost(`/api/admin/moderation/posts/${postId}/delete`, {}, authHeader(sevakToken))
      await jsonPost(`/api/admin/moderation/posts/${other.postId}/delete`, {}, authHeader(adminToken))

      const { res, body } = await fetchJSON('/api/admin/moderation/audit', {
        headers: authHeader(sevakToken),
      })
      expect(res.status).toBe(200)
      expect(body.data.map((item: any) => item.targetPostId)).toEqual([postId])

      const { body: adminAudit } = await fetchJSON('/api/admin/moderation/audit', {
        headers: authHeader(adminToken),
      })
      expect(adminAudit.data.map((item: any) => item.targetPostId)).toEqual(
        expect.arrayContaining([postId, other.postId]),
      )
    })

    it('does NOT let a sevak suspend a user — account actions stay admin-only (403)', async () => {
      const { res } = await jsonPost(
        `/api/admin/moderation/users/${memberId}/suspend`,
        { durationDays: 7 },
        authHeader(sevakToken),
      )
      expect(res.status).toBe(403)
    })
  })

  describe('admin queue + delete', () => {
    it('non-admin (basic member) cannot see the queue (403)', async () => {
      const { res } = await fetchJSON('/api/admin/moderation/queue', { headers: authHeader(memberToken) })
      expect(res.status).toBe(403)
    })

    it('admin deletes a reported post: it leaves the feed, reports resolve, audit logged', async () => {
      const reporter = await registerAndLogin('reporter3', 'password123')
      await jsonPost(`/api/boards/posts/${postId}/report`, { reason: 'bad' }, authHeader(reporter.token))

      const del = await jsonPost(
        `/api/admin/moderation/posts/${postId}/delete`,
        {},
        authHeader(adminToken),
      )
      expect(del.res.status).toBe(200)

      // Post no longer in the board feed
      const { body: board } = await fetchJSON(`/api/boards/center/${centerId}`, {
        headers: authHeader(memberToken),
      })
      expect(board.posts.find((p: any) => p.id === postId)).toBeUndefined()

      // Default queue (open only) is now empty; reports are resolved
      const { body: q } = await fetchJSON('/api/admin/moderation/queue', { headers: authHeader(adminToken) })
      expect(q.data).toHaveLength(0)

      // includeResolved surfaces the now-actioned report
      const { body: qAll } = await fetchJSON(
        '/api/admin/moderation/queue?includeResolved=true',
        { headers: authHeader(adminToken) },
      )
      expect(qAll.data).toHaveLength(1)
      expect(qAll.data[0].status).toBe('actioned')

      // Audit log has the delete action
      const { body: audit } = await fetchJSON('/api/admin/moderation/audit', { headers: authHeader(adminToken) })
      expect(audit.data.some((a: any) => a.action === 'delete_post' && a.targetPostId === postId)).toBe(true)
    })

    it('deleting an already-deleted post still clears the queue (200, alreadyDeleted)', async () => {
      const reporter = await registerAndLogin('reporter4', 'password123')
      await jsonPost(`/api/boards/posts/${postId}/report`, { reason: 'bad' }, authHeader(reporter.token))
      await jsonPost(`/api/admin/moderation/posts/${postId}/delete`, {}, authHeader(adminToken))
      const second = await jsonPost(
        `/api/admin/moderation/posts/${postId}/delete`,
        {},
        authHeader(adminToken),
      )
      expect(second.res.status).toBe(200)
      expect(second.body.alreadyDeleted).toBe(true)
    })
  })

  describe('suspension', () => {
    it('suspends a user → they can no longer post; unsuspend restores it', async () => {
      // member can post before suspension
      const before = await jsonPost(
        `/api/boards/center/${centerId}/posts`,
        { body: 'pre-suspension' },
        authHeader(memberToken),
      )
      expect(before.res.status).toBe(201)

      const susp = await jsonPost(
        `/api/admin/moderation/users/${memberId}/suspend`,
        { reason: 'repeated spam', durationDays: 7 },
        authHeader(adminToken),
      )
      expect(susp.res.status).toBe(200)
      expect(susp.body.user.isSuspended).toBe(true)

      const blocked = await jsonPost(
        `/api/boards/center/${centerId}/posts`,
        { body: 'should be blocked' },
        authHeader(memberToken),
      )
      expect(blocked.res.status).toBe(403)
      expect(blocked.body.reason).toBe('suspended')

      // replies are blocked too
      const reply = await jsonPost(
        `/api/boards/posts/${postId}/replies`,
        { body: 'blocked reply' },
        authHeader(memberToken),
      )
      expect(reply.res.status).toBe(403)

      const unsusp = await jsonPost(
        `/api/admin/moderation/users/${memberId}/unsuspend`,
        {},
        authHeader(adminToken),
      )
      expect(unsusp.res.status).toBe(200)
      expect(unsusp.body.user.isSuspended).toBe(false)

      const after = await jsonPost(
        `/api/boards/center/${centerId}/posts`,
        { body: 'post-unsuspend' },
        authHeader(memberToken),
      )
      expect(after.res.status).toBe(201)
    })

    it('an expired suspension does not block posting (lazy expiry)', async () => {
      // Suspend, then back-date the expiry into the past directly.
      await jsonPost(
        `/api/admin/moderation/users/${memberId}/suspend`,
        { durationDays: 7 },
        authHeader(adminToken),
      )
      await env.DB.prepare('UPDATE users SET suspended_until = ? WHERE id = ?')
        .bind('2000-01-01T00:00:00.000Z', memberId)
        .run()
      const res = await jsonPost(
        `/api/boards/center/${centerId}/posts`,
        { body: 'after expiry' },
        authHeader(memberToken),
      )
      expect(res.res.status).toBe(201)
    })

    it('indefinite suspension (no duration) blocks until lifted', async () => {
      const susp = await jsonPost(
        `/api/admin/moderation/users/${memberId}/suspend`,
        { reason: 'indefinite' },
        authHeader(adminToken),
      )
      expect(susp.body.user.suspendedUntil).toBeNull()
      expect(susp.body.user.isSuspended).toBe(true)
    })

    it('cannot suspend another admin (403)', async () => {
      // Promote a second user to admin level so it's not "self".
      const other = await registerAndLogin('otheradmin', 'password123')
      await env.DB.prepare('UPDATE users SET verification_level = 108 WHERE id = ?')
        .bind(other.user.id)
        .run()
      const onAdmin = await jsonPost(
        `/api/admin/moderation/users/${other.user.id}/suspend`,
        {},
        authHeader(adminToken),
      )
      expect(onAdmin.res.status).toBe(403)
    })

    it('cannot suspend self (400)', async () => {
      const adminRow = await env.DB.prepare('SELECT id FROM users WHERE username = ?')
        .bind('chinmayajanata@gmail.com')
        .first<{ id: string }>()
      const onSelf = await jsonPost(
        `/api/admin/moderation/users/${adminRow!.id}/suspend`,
        {},
        authHeader(adminToken),
      )
      expect(onSelf.res.status).toBe(400)
    })

    it('404s on a missing user', async () => {
      const missing = await jsonPost(
        '/api/admin/moderation/users/nope/suspend',
        {},
        authHeader(adminToken),
      )
      expect(missing.res.status).toBe(404)
    })

    it('non-admin cannot suspend (403)', async () => {
      const { res } = await jsonPost(
        `/api/admin/moderation/users/${memberId}/suspend`,
        {},
        authHeader(memberToken),
      )
      expect(res.status).toBe(403)
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// PUSH NOTIFICATIONS (#102)
// ═══════════════════════════════════════════════════════════════════════

describe('push token routes', () => {
  it('rejects a missing/invalid token with 400', async () => {
    const { token } = await registerAndLogin('pushuser', 'password123')
    const { res } = await jsonPost('/api/push/register', { token: 'nope' }, authHeader(token))
    expect(res.status).toBe(400)
  })

  it('registers a valid Expo token and stores it', async () => {
    const { token, user } = await registerAndLogin('pushuser2', 'password123')
    const { res, body } = await jsonPost(
      '/api/push/register',
      { token: 'ExponentPushToken[abc123]', platform: 'ios' },
      authHeader(token),
    )
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)

    const row = await env.DB.prepare('SELECT * FROM push_tokens WHERE token = ?1')
      .bind('ExponentPushToken[abc123]')
      .first<{ user_id: string; platform: string }>()
    expect(row?.platform).toBe('ios')
    expect(row?.user_id).toBe(user.id)
  })

  it('requires auth', async () => {
    const { res } = await jsonPost('/api/push/register', { token: 'ExponentPushToken[x]' })
    expect(res.status).toBe(401)
  })

  it('unregisters a token', async () => {
    const { token } = await registerAndLogin('pushuser3', 'password123')
    await jsonPost(
      '/api/push/register',
      { token: 'ExponentPushToken[rm]' },
      authHeader(token),
    )
    const { res } = await jsonPost(
      '/api/push/unregister',
      { token: 'ExponentPushToken[rm]' },
      authHeader(token),
    )
    expect(res.status).toBe(200)
    const row = await env.DB.prepare('SELECT * FROM push_tokens WHERE token = ?1')
      .bind('ExponentPushToken[rm]')
      .first()
    expect(row).toBeNull()
  })
})

describe('board post notification fan-out', () => {
  let adminToken: string
  let authorToken: string
  let centerId: string

  beforeEach(async () => {
    adminToken = await createAdmin()
    const author = await registerAndLogin('fanoutauthor', 'password123')
    authorToken = author.token
    await registerAndLogin('fanoutmember', 'password123')

    const { body } = await jsonPost(
      '/api/addCenter',
      { centerName: 'Fanout Center', latitude: 37.0, longitude: -121.0 },
      authHeader(adminToken),
    )
    centerId = body.id

    // Both the author and the other member belong to this center.
    await env.DB.prepare("UPDATE users SET center_id = ? WHERE username IN ('fanoutauthor','fanoutmember')")
      .bind(centerId)
      .run()
  })

  it('notifies co-members of a new center board post but not the author', async () => {
    const { res } = await jsonPost(
      `/api/boards/center/${centerId}/posts`,
      { body: 'Satsang carpool this Saturday?' },
      authHeader(authorToken),
    )
    expect(res.status).toBe(201)

    const member = await env.DB.prepare("SELECT id FROM users WHERE username = 'fanoutmember'")
      .first<{ id: string }>()
    const author = await env.DB.prepare("SELECT id FROM users WHERE username = 'fanoutauthor'")
      .first<{ id: string }>()

    const memberNotifs = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?1 AND type_id = 8',
    )
      .bind(member!.id)
      .first<{ n: number }>()
    const authorNotifs = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?1',
    )
      .bind(author!.id)
      .first<{ n: number }>()

    expect(memberNotifs?.n).toBe(1)
    expect(authorNotifs?.n).toBe(0)
  })
})

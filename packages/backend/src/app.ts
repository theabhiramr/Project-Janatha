/**
 * app.ts
 *
 * Om Sri Chinmaya Sadgurave Namaha. Om Sri Gurubyo Namaha.
 *
 * Hono application for Chinmaya Janata backend.
 * Runs on Cloudflare Workers / Pages Functions.
 *
 * All Express routes ported to Hono with D1 + Web Crypto auth.
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env, UserRow, EventRow, CenterRow, BoardPostApiResponse, BoardType } from './types'
import {
  userRowToApi,
  userRowToAttendee,
  userRowToPublicProfile,
  centerRowToApi,
  eventRowToApi,
  boardRowToApi,
  isUserSuspended,
  moderationActionRowToApi,
} from './types'
import {
  hashPassword,
  verifyPassword,
  generateToken,
  generateRefreshToken,
  verifyToken,
  verifyRefreshToken,
  passwordFingerprint,
} from './auth'
import * as db from './db'
import * as inviteCodes from './inviteCodes'
import * as notifications from './notifications'
import * as push from './push'
import * as passwordReset from './passwordReset'
import { sendVerificationEmail } from './email'
import { ADMIN_EMAIL, NORMAL_USER, SEVAK, BRAHMACHARI, TIER_DESCALE, ADMIN_CUTOFF, DEVELOPER_EMAILS, UNVERIFIED_USER } from './constants'
import { rateLimit, cacheControl, securityHeaders, validate } from './middleware'

// ── Hono app type with CF bindings ────────────────────────────────────

type HonoEnv = {
  Bindings: Env
  Variables: {
    user: UserRow
  }
}

export const app = new Hono<HonoEnv>().basePath('/api')

// ── Helper: Check if user is admin ─────────────────────────────────────

function isAdmin(user: { email: string | null; verification_level: number }): boolean {
  return user.email === ADMIN_EMAIL || user.verification_level >= ADMIN_CUTOFF
}

const BOARD_REACTIONS = new Set(['🙏', '👍', '🪔', '❤️', '🚗', '🌾'])

function isBoardType(value: string): value is BoardType {
  return value === 'center' || value === 'event'
}

function boardPostToApi(post: db.BoardPostWithAuthor): BoardPostApiResponse {
  return {
    id: post.id,
    boardId: post.board_id,
    visibility: post.visibility,
    body: post.body,
    imageUrl: post.image_url,
    createdAt: post.created_at,
    updatedAt: post.updated_at,
    deletedAt: post.deleted_at,
    pinnedAt: post.pinned_at,
    pinnedBy: post.pinned_by,
    author: userRowToApi(post.author),
    reactions: post.reactions,
    replyCount: post.reply_count,
  }
}

/**
 * Fire notification fan-out without blocking the response (#102). Uses
 * executionCtx.waitUntil when available (production / dev Workers runtime) so
 * the originating write returns immediately; falls back to awaiting in test
 * environments where executionCtx is absent. Errors are swallowed — a push
 * failure must never surface as a failed post / RSVP.
 */
/** Human-friendly name for notification copy. Falls back to username. */
function displayName(user: Pick<UserRow, 'first_name' | 'last_name' | 'username'>): string {
  const full = `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim()
  return full || user.username || 'Someone'
}

/** Trim a post body to a single-line preview for the notification message. */
function preview(text: string, max = 140): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine
}

function fireNotify(c: any, work: Promise<unknown>): void {
  const safe = Promise.resolve(work).catch((err) =>
    console.error('[notify] fan-out failed:', err),
  )
  try {
    c.executionCtx?.waitUntil(safe)
  } catch {
    // No executionCtx (tests) — let it run detached.
    void safe
  }
}

/**
 * Returns a 403 response if the user's posting privileges are suspended
 * (#209), else null. Reads are never gated — only content creation.
 */
function suspendedPostingResponse(c: any, user: UserRow): Response | null {
  if (!isUserSuspended(user)) return null
  return c.json(
    {
      message: user.suspended_until
        ? 'Your posting privileges are suspended until ' + user.suspended_until
        : 'Your posting privileges are currently suspended',
      reason: 'suspended',
      suspendedUntil: user.suspended_until,
    },
    403,
  )
}

async function verifyBoardAccess(
  c: any,
  type: BoardType,
  parentId: string,
  user: UserRow,
): Promise<Response | null> {
  if (!parentId) {
    return c.json({ message: 'Board parent ID is required' }, 400)
  }

  const userIsAdmin = isAdmin(user)

  if (type === 'center') {
    const center = await db.getCenterById(c.env.DB, parentId)
    if (!center) {
      return c.json({ message: 'Center not found' }, 404)
    }
    if (!userIsAdmin && user.center_id !== parentId) {
      return c.json({ message: 'You do not have access to this center board' }, 403)
    }
    return null
  }

  const event = await db.getEventById(c.env.DB, parentId)
  if (!event) {
    return c.json({ message: 'Event not found' }, 404)
  }

  const isCreator = event.created_by === user.id
  const isAttending = await db.isUserAttending(c.env.DB, parentId, user.id)
  if (!userIsAdmin && !isCreator && !isAttending) {
    return c.json({ message: 'You do not have access to this event board' }, 403)
  }

  return null
}

// ── Admin middleware ─────────────────────────────────────────────────

async function adminMiddleware(c: any, next: () => Promise<void>): Promise<Response | void> {
  const authResult = await authMiddleware(c, async () => {})
  if (authResult) return authResult
  const user = c.get('user')
  if (!user || !isAdmin(user)) {
    return c.json({ message: 'Admin access required' }, 403)
  }
  await next()
}

// Moderator gate: global admins OR sevak-and-above (verification_level >= SEVAK).
// Used for content-moderation actions (report queue, post removal, audit log) so
// the many MSC center sevaks can moderate their boards. Account-level actions
// (suspend / unsuspend a user) stay admin-only via adminMiddleware.
async function moderatorMiddleware(c: any, next: () => Promise<void>): Promise<Response | void> {
  const authResult = await authMiddleware(c, async () => {})
  if (authResult) return authResult
  const user = c.get('user')
  if (!user || (!isAdmin(user) && user.verification_level < SEVAK)) {
    return c.json({ message: 'Moderator access required (sevak or admin)' }, 403)
  }
  await next()
}

// Content moderation policy: global admins moderate every report. Sevaks are
// local moderators only: center-board reports for their own center, and
// event-board reports when the event belongs to their center, was created by
// them, or they attend it. Public/global feed reports have no local owner and
// remain admin-only.
function moderationScopeFor(user: UserRow): db.ModerationScope {
  if (isAdmin(user)) return { isAdmin: true }
  return {
    isAdmin: false,
    userId: user.id,
    centerId: user.center_id,
  }
}

// ── Global error handler ──────────────────────────────────────────────

app.onError((err, c) => {
  console.error(`[${c.req.method}] ${c.req.path} — Unhandled error:`, err)
  const errorMessage = err instanceof Error ? err.message : String(err)
  const stack = err instanceof Error ? err.stack : ''
  console.error('Stack:', stack)
  return c.json({ message: 'Internal server error', error: errorMessage }, 500)
})

// ── Global middleware ─────────────────────────────────────────────────

app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) return '*'
      // Canonical frontend = chinmayajanata.org (CNAME → project-janatha.pages.dev).
      // The chinmaya-janata.pages.dev entries are the OLD Pages project — frozen,
      // doesn't receive deploys, but kept in the allowlist as a safety net in case
      // a stale link out there still routes there. See #165.
      const allowed = [
        'https://chinmayajanata.org',
        'https://www.chinmayajanata.org',
        'https://project-janatha.pages.dev',
        'https://main.project-janatha.pages.dev',
        'https://v2preview.project-janatha.pages.dev',
        'https://chinmaya-janata.pages.dev', // legacy frozen project
        'http://localhost:8081',
        'http://localhost:8787',
        'http://localhost:19006',
      ]
      if (allowed.includes(origin)) return origin
      if (origin.startsWith('http://localhost:')) return origin
      return ''
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    maxAge: 86400,
  })
)

app.use('*', securityHeaders)

// ── Auth middleware factory ───────────────────────────────────────────

async function authMiddleware(c: any, next: () => Promise<void>): Promise<Response | void> {
  const authHeader = c.req.header('Authorization')
  if (!authHeader) {
    return c.json({ message: 'Authorization header missing' }, 401)
  }

  const parts = authHeader.split(' ')
  const token = parts.length > 1 ? parts[1] : parts[0]
  if (!token) {
    return c.json({ message: 'Authorization header missing' }, 401)
  }

  const decoded = await verifyToken(token, c.env.JWT_SECRET)
  if (!decoded || decoded.type !== 'access') {
    return c.json({ message: 'Invalid or expired token' }, 403)
  }

  const userData = await db.getUserByUsername(c.env.DB, decoded.username)
  if (!userData) {
    return c.json({ message: 'User not found' }, 403)
  }

  // Session-kill on password change: tokens minted after the rollout carry a
  // `tv` claim fingerprinting the password hash at issue time. If the password
  // has rotated since (reset flow), the fingerprints diverge and the token
  // dies. JWTs without a `tv` claim were issued before this check existed —
  // accept them so existing users aren't logged out at deploy.
  if (typeof decoded.tv === 'string') {
    const expected = await passwordFingerprint(userData.password)
    if (decoded.tv !== expected) {
      return c.json({ message: 'Session expired, please sign in again' }, 401)
    }
  }

  c.set('user', userData)
  await next()
}

// ── Health check ──────────────────────────────────────────────────────

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    message: 'Backend is running',
    version: '0.2.0',
    timestamp: new Date().toISOString(),
  })
})

// ── User existence check ──────────────────────────────────────────────

app.post('/userExistence', async (c) => {
  const { username } = await c.req.json<{ username: string }>()
  if (!username) {
    return c.json({ existence: false })
  }
  const user = await db.getUserByUsername(c.env.DB, username)
  return c.json({ existence: !!user })
})

// ═══════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════

/**
 * POST /api/auth/validate-invite-code
 * Validate an invite code for beta access
 * Public endpoint (no authentication required)
 */
// Read-only invite lookup (Door 1 vouch + signup applied bar). Codes are
// unguessable 48-bit randoms, so brute-force enumeration isn't a real threat;
// the tight 10/min cap mainly punished legit invitees sharing a venue's NAT IP
// at MSC. Raised to a venue-friendly 60/min; the client retries transient 429s
// rather than showing "invite isn't active" (#403).
app.post('/auth/validate-invite-code', rateLimit(60, 60_000), async (c) => {
  let body: { code?: string } = {}
  try {
    body = await c.req.json<{ code: string }>()
  } catch {
    // Empty body
  }

  if (!body.code || typeof body.code !== 'string' || body.code.trim().length === 0) {
    return c.json({ valid: false, error: 'Invite code is required' }, 400)
  }

  const status = await inviteCodes.classifyInviteCode(c.env, body.code)
  if (status === 'ok') {
    // Door 1 vouch (#403): include the inviter's first name when the link was
    // minted by a member. Null for admin cohort codes → nameless vouch.
    const inviterFirstName = await inviteCodes.getInviterFirstName(c.env, body.code)
    return c.json({ valid: true, inviterFirstName })
  }

  const messages: Record<Exclude<inviteCodes.InviteCodeStatus, 'ok'>, string> = {
    not_found: 'Invalid or inactive invite code',
    inactive: 'This invite link has been deactivated',
    expired: 'This invite link has expired',
    exhausted: 'This invite link has reached its maximum number of uses',
  }
  return c.json({ valid: false, error: messages[status], reason: status })
})

app.post('/auth/register', rateLimit(5, 60_000), async (c) => {
  const body = await c.req.json<{
    username: string
    password: string
    inviteCode?: string
  }>()

  const normalizedUsername = validate.username(body.username)
  const validPassword = validate.password(body.password)

  if (!normalizedUsername || !validPassword) {
    return c.json({ message: 'Username and password are required' }, 400)
  }

  if (validPassword.length < 8) {
    return c.json({ message: 'Password must be at least 8 characters long' }, 400)
  }

  const existingUser = await db.getUserByUsername(c.env.DB, normalizedUsername.toLowerCase())
  if (existingUser) {
    return c.json({ message: 'Username already exists' }, 409)
  }

  // v2 invite-links model (#342): the invite link is the door. An account
  // created through a valid invite link is VERIFIED at inception (Bluesky/
  // Clubhouse), so we promote to NORMAL_USER immediately at register rather
  // than deferring the bump to email-verify. Developer emails bypass to
  // BRAHMACHARI.
  //
  // Hard gate (#342 follow-up): when REQUIRE_INVITE_CODE is "true" Janata is
  // invite-only at the API — a non-developer signup with no valid invite is
  // refused (403), matching the invite-wall UI (#458). Existing accounts are
  // grandfathered automatically (the gate only guards new registrations); the
  // seed script and developers pass by presenting a code / bypassing. When the
  // flag is off, the legacy soft path stands: no invite → UNVERIFIED_USER.
  const isDeveloper = DEVELOPER_EMAILS.includes(normalizedUsername.toLowerCase())
  const requireInvite = c.env.REQUIRE_INVITE_CODE === 'true'
  const hasInviteCode =
    typeof body.inviteCode === 'string' && body.inviteCode.trim().length > 0

  let verificationLevel = UNVERIFIED_USER
  let inviteCodeUsed: string | null = null
  let invitedByUserId: string | null = null

  if (isDeveloper) {
    verificationLevel = BRAHMACHARI
  } else if (hasInviteCode) {
    const inviteCodeData = await inviteCodes.validateInviteCode(c.env, body.inviteCode!)
    if (!inviteCodeData) {
      return c.json({ message: 'Invalid or inactive invite code' }, 401)
    }
    // Atomically consume the code so single-use invites can't be raced by
    // two simultaneous signups. Admin cohort codes (max_uses=NULL) succeed
    // trivially.
    const consumed = await inviteCodes.consumeInviteCode(c.env, inviteCodeData.code)
    if (!consumed) {
      return c.json({ message: 'Invite code already redeemed or expired' }, 409)
    }
    inviteCodeUsed = inviteCodeData.code
    invitedByUserId = inviteCodeData.created_by_user_id
    // Invited = verified at inception, at the role the link grants (#451):
    // member links → NORMAL_USER; sevak/admin links land the recipient at that
    // role. Floored at NORMAL_USER so a link never downgrades. Email
    // confirmation stays quiet and non-blocking (used only for password recovery).
    verificationLevel = Math.max(NORMAL_USER, inviteCodeData.verification_level)
  } else if (requireInvite) {
    // Invite-only: no developer bypass, no code → no account.
    return c.json(
      { message: 'An invite is required to join Janata. Ask a member for an invite link.' },
      403,
    )
  }

  const hashedPassword = await hashPassword(validPassword)
  const userId = crypto.randomUUID()

  try {
    const created = await db.createUser(c.env.DB, {
      id: userId,
      username: normalizedUsername.toLowerCase(),
      password: hashedPassword,
      email: normalizedUsername.toLowerCase(),
      verification_level: verificationLevel,
      invite_code: inviteCodeUsed,
      invited_by_user_id: invitedByUserId,
    })

    if (!created.success) {
      const status = created.error === 'User already exists' ? 409 : 500
      return c.json(
        {
          message:
            created.error === 'User already exists'
              ? 'Username already exists'
              : 'Failed to create user',
        },
        status,
      )
    }

    // Auto-send verification email (non-fatal). Skipped for developer accounts
    // since they're already at BRAHMACHARI and don't need to verify. If the
    // send fails (Resend down, etc.) the user can request a resend via
    // POST /auth/send-verification-email.
    if (!isDeveloper) {
      try {
        const bytes = new Uint8Array(32)
        crypto.getRandomValues(bytes)
        const token = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

        await c.env.DB.prepare(
          `INSERT INTO email_verification_tokens (token, user_id, expires_at) VALUES (?, ?, ?)`,
        )
          .bind(token, userId, expiresAt)
          .run()

        await sendVerificationEmail(c.env, { email: normalizedUsername.toLowerCase() }, token)
      } catch (err: any) {
        console.error('signup verification email error:', err)
        // Non-fatal: user can request a resend later.
      }
    }

    return c.json(
      { message: 'User registered successfully', username: normalizedUsername.toLowerCase() },
      201,
    )
  } catch (err: any) {
    console.error('createUser error:', err)
    return c.json({ message: 'Failed to create user', error: err?.message }, 500)
  }
})

app.post('/auth/authenticate', rateLimit(5, 60_000), async (c) => {
  const body = await c.req.json<{
    username: string
    password: string
  }>()

  const normalizedUsername = validate.username(body.username)
  const validPassword = validate.password(body.password)

  if (!normalizedUsername || !validPassword) {
    return c.json({ message: 'Username and password are required.' }, 400)
  }

  const identifier = normalizedUsername.toLowerCase()
  const user =
    (await db.getUserByUsername(c.env.DB, identifier)) ??
    (await db.getUserByEmail(c.env.DB, identifier))
  if (!user) {
    return c.json({ message: 'Invalid credentials' }, 401)
  }

  const passwordMatch = await verifyPassword(validPassword, user.password)
  if (!passwordMatch) {
    return c.json({ message: 'Invalid credentials' }, 401)
  }

  const jwtSecret = c.env.JWT_SECRET
  const refreshSecret = c.env.JWT_REFRESH_SECRET || jwtSecret

  const token = await generateToken(user, jwtSecret)
  const refreshToken = await generateRefreshToken(user, refreshSecret)

  return c.json({
    message: 'Authentication successful!',
    user: userRowToApi(user),
    token,
    refreshToken,
  })
})

app.post('/auth/deauthenticate', (c) => {
  return c.json({ message: 'Deauthentication successful!' })
})

// ── Refresh token endpoint ────────────────────────────────────────────

app.post('/auth/refresh', async (c) => {
  try {
    const { refreshToken } = await c.req.json<{ refreshToken: string }>()
    if (!refreshToken) {
      return c.json({ message: 'Refresh token is required' }, 400)
    }

    const refreshSecret = c.env.JWT_REFRESH_SECRET || c.env.JWT_SECRET
    const decoded = await verifyRefreshToken(refreshToken, refreshSecret)
    if (!decoded) {
      return c.json({ message: 'Invalid or expired refresh token' }, 401)
    }

    const user = await db.getUserByUsername(c.env.DB, decoded.username)
    if (!user) {
      return c.json({ message: 'User not found' }, 401)
    }

    // Match authMiddleware: refresh tokens minted after the tv rollout should
    // die after a password reset, while legacy no-tv tokens remain valid.
    if (typeof decoded.tv === 'string') {
      const expected = await passwordFingerprint(user.password)
      if (decoded.tv !== expected) {
        return c.json({ message: 'Session expired, please sign in again' }, 401)
      }
    }

    const newAccessToken = await generateToken(user, c.env.JWT_SECRET)
    const newRefreshToken = await generateRefreshToken(user, refreshSecret)

    return c.json({
      message: 'Token refreshed',
      token: newAccessToken,
      refreshToken: newRefreshToken,
      user: userRowToApi(user),
    })
  } catch {
    return c.json({ message: 'Failed to refresh token' }, 500)
  }
})

app.get('/auth/verify', authMiddleware, (c) => {
  const user = c.get('user')
  return c.json({
    message: 'Token is valid',
    user: userRowToApi(user),
  })
})

// ── Email verification (v2) ───────────────────────────────────────────
//
// Promotion path: signup lands at UNVERIFIED_USER (30). User receives an
// email with a verification link. GET /auth/verify-email consumes the
// token, sets email_verified_at, and (if the user has a stored invite
// code) bumps their verification_level to the code's level. See
// docs/plans/2026-05-05-v2-roles-invites-messaging.md §4-5.

app.post('/auth/send-verification-email', rateLimit(3, 60 * 60_000), authMiddleware, async (c) => {
  const user = c.get('user')
  if (!user.email) {
    return c.json({ message: 'User has no email on file' }, 400)
  }
  if (user.email_verified_at) {
    return c.json({ message: 'Email already verified' }, 400)
  }

  // 32 bytes = 64 hex chars = 256 bits entropy
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const token = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

  try {
    await c.env.DB.prepare(
      `INSERT INTO email_verification_tokens (token, user_id, expires_at) VALUES (?, ?, ?)`,
    )
      .bind(token, user.id, expiresAt)
      .run()

    await sendVerificationEmail(c.env, { email: user.email }, token)
  } catch (err: any) {
    console.error('send-verification-email error:', err)
    return c.json({ message: 'Failed to send verification email' }, 500)
  }

  return c.json({ message: 'Verification email sent' })
})

app.get('/auth/verify-email', async (c) => {
  const token = c.req.query('token')
  if (!token || typeof token !== 'string') {
    return c.json({ message: 'Token is required' }, 400)
  }

  const row = await c.env.DB.prepare(
    `SELECT token, user_id, expires_at, consumed_at
       FROM email_verification_tokens WHERE token = ?`,
  )
    .bind(token)
    .first<{ token: string; user_id: string; expires_at: string; consumed_at: string | null }>()

  if (!row) {
    return c.json({ message: 'Invalid token' }, 410)
  }
  if (row.consumed_at) {
    return c.json({ message: 'Token already used' }, 410)
  }
  if (new Date(row.expires_at) <= new Date()) {
    return c.json({ message: 'Token expired' }, 410)
  }

  const user = await db.getUserById(c.env.DB, row.user_id)
  if (!user) {
    return c.json({ message: 'User not found' }, 404)
  }

  const now = new Date().toISOString()

  // Path A promotion: if user signed up with an invite code and hasn't been
  // promoted yet, apply the code's verification_level now. Won't downgrade.
  // Use getInviteCode (not validateInviteCode) since single-use codes are
  // already consumed at signup; we just need the recorded level.
  let newLevel = user.verification_level
  if (user.invite_code && user.verification_level < NORMAL_USER) {
    const inviteCode = await inviteCodes.getInviteCode(c.env, user.invite_code)
    if (inviteCode) {
      newLevel = Math.max(user.verification_level, inviteCode.verification_level)
    }
  }

  await c.env.DB.prepare(
    `UPDATE email_verification_tokens SET consumed_at = ? WHERE token = ?`,
  )
    .bind(now, token)
    .run()

  const updates: Partial<UserRow> = { email_verified_at: now }
  if (newLevel !== user.verification_level) {
    updates.verification_level = newLevel
  }
  await db.updateUser(c.env.DB, user.id, updates)

  const updated = await db.getUserById(c.env.DB, user.id)
  return c.json({
    message: 'Email verified',
    user: updated ? userRowToApi(updated) : null,
  })
})

// ── Password reset (v2) ───────────────────────────────────────────────
//
// Self-serve flow: user requests a 6-digit code (always returns ok to
// avoid enumeration), then submits the code + new password to /verify.
// On success, every live JWT for the user dies via the password-hash
// fingerprint in auth.ts. See docs/plans/2026-05-24-password-reset.md.

app.post('/auth/password-reset/request', rateLimit(5, 60_000), async (c) => {
  let body: { username?: string } = {}
  try {
    body = await c.req.json<{ username: string }>()
  } catch {
    // empty body -- still return ok so attackers learn nothing
  }
  if (body.username && typeof body.username === 'string') {
    await passwordReset.handlePasswordResetRequest(c.env, body.username)
  }
  return c.json({ ok: true })
})

app.post('/auth/password-reset/verify', rateLimit(10, 60_000), async (c) => {
  let body: { username?: string; code?: string; newPassword?: string } = {}
  try {
    body = await c.req.json()
  } catch {
    // fall through to validation below
  }
  if (
    typeof body.username !== 'string' ||
    typeof body.code !== 'string' ||
    typeof body.newPassword !== 'string'
  ) {
    return c.json({ ok: false, error: 'Missing required fields' }, 400)
  }

  const result = await passwordReset.handlePasswordResetVerify(
    c.env,
    body.username,
    body.code,
    body.newPassword,
  )
  return c.json(result, result.ok ? 200 : 400)
})

// ── User-issued invite codes (v2) ─────────────────────────────────────
//
// Verified users can mint single-use, 30-day-expiry links and share them.
// Recipients redeem either at signup (handled in /auth/register) or
// post-signup via /auth/redeem-invite. See
// docs/plans/2026-05-05-v2-roles-invites-messaging.md §5.A.

const INVITE_SHARE_URL_BASE = 'https://janata.app/i'

app.post('/auth/invite-codes', authMiddleware, async (c) => {
  const user = c.get('user')
  if (user.verification_level < NORMAL_USER) {
    return c.json({ message: 'Only verified users can issue invite codes' }, 403)
  }

  const body = await c.req
    .json<{ maxUses?: number; expiresInDays?: number; role?: string }>()
    .catch(() => ({}) as { maxUses?: number; expiresInDays?: number; role?: string })

  // Optional overrides; out-of-range values are clamped in the lib, but reject
  // non-integers so a typo doesn't silently fall back to the default.
  if (body.maxUses !== undefined && !Number.isInteger(body.maxUses)) {
    return c.json({ message: 'maxUses must be an integer' }, 400)
  }
  if (body.expiresInDays !== undefined && !Number.isInteger(body.expiresInDays)) {
    return c.json({ message: 'expiresInDays must be an integer' }, 400)
  }

  // Role-bearing links (#451): default to a member link. A minter can grant up
  // to their own level — so sevaks can mint sevak links, admins can mint admin
  // links, but a member can only mint member links. Email-admins (ADMIN_EMAIL)
  // count as admin-capable even if their numeric level is low.
  let verificationLevel = NORMAL_USER
  let grantedRole: inviteCodes.InviteRole = 'member'
  if (body.role !== undefined) {
    const level = inviteCodes.INVITE_ROLE_LEVELS[body.role as inviteCodes.InviteRole]
    if (level === undefined) {
      return c.json({ message: 'role must be one of: member, sevak, admin' }, 400)
    }
    const minterLevel = isAdmin(user)
      ? Math.max(user.verification_level, inviteCodes.INVITE_ROLE_LEVELS.admin)
      : user.verification_level
    if (level > minterLevel) {
      return c.json({ message: 'You can only grant a role up to your own.' }, 403)
    }
    verificationLevel = level
    grantedRole = body.role as inviteCodes.InviteRole
  }

  const result = await inviteCodes.mintUserInviteCode(c.env, user.id, {
    maxUses: body.maxUses,
    expiresInDays: body.expiresInDays,
    verificationLevel,
  })
  if (!result.success) {
    console.error('mintUserInviteCode error:', result.error)
    return c.json({ message: 'Failed to mint invite code' }, 500)
  }

  return c.json({
    code: result.code,
    expiresAt: result.expiresAt,
    maxUses: result.maxUses,
    role: grantedRole,
    verificationLevel,
    shareUrl: `${INVITE_SHARE_URL_BASE}/${result.code}`,
  })
})

app.get('/auth/invite-codes/mine', authMiddleware, async (c) => {
  const user = c.get('user')
  const rows = await inviteCodes.getUserMintedCodes(c.env, user.id)
  return c.json({
    codes: rows.map((row) => ({
      ...inviteCodes.inviteCodeRowToApi(row),
      shareUrl: `${INVITE_SHARE_URL_BASE}/${row.code}`,
    })),
  })
})

app.post('/auth/redeem-invite', rateLimit(5, 60_000), authMiddleware, async (c) => {
  const user = c.get('user')

  if (user.verification_level >= NORMAL_USER) {
    return c.json({ message: 'Already verified; no invite needed' }, 400)
  }
  if (user.invite_code) {
    return c.json({ message: 'An invite code is already associated with this account' }, 400)
  }

  const body = await c.req.json<{ code?: string }>().catch(() => ({ code: undefined }))
  if (!body.code || typeof body.code !== 'string' || body.code.trim().length === 0) {
    return c.json({ message: 'Invite code is required' }, 400)
  }

  // Fetch once and both classify (for a specific error: expired vs exhausted
  // vs deactivated) and consume off the same row. The atomic guard in
  // consumeInviteCode is what actually prevents over-redemption under load.
  const codeRow = await inviteCodes.getInviteCode(c.env, body.code)
  const status = inviteCodes.classifyInviteCodeRow(codeRow)
  if (status !== 'ok' || !codeRow) {
    const reasons: Record<
      Exclude<inviteCodes.InviteCodeStatus, 'ok'>,
      { message: string; code: 401 | 403 | 409 | 410 }
    > = {
      not_found: { message: 'Invalid invite code', code: 401 },
      inactive: { message: 'This invite link has been deactivated', code: 403 },
      expired: { message: 'This invite link has expired', code: 410 },
      exhausted: { message: 'This invite link has reached its maximum number of uses', code: 409 },
    }
    const r = reasons[status === 'ok' ? 'not_found' : status]
    return c.json({ message: r.message, reason: status === 'ok' ? 'not_found' : status }, r.code)
  }

  const consumed = await inviteCodes.consumeInviteCode(c.env, codeRow.code)
  if (!consumed) {
    // Race: the last remaining use was taken between classify and consume.
    return c.json(
      { message: 'This invite link has reached its maximum number of uses', reason: 'exhausted' },
      409,
    )
  }

  // Record the code on the user. If email is already verified, apply the
  // promotion now. Otherwise the bump happens at email-verify.
  const updates: Partial<UserRow> = {
    invite_code: codeRow.code,
    invited_by_user_id: codeRow.created_by_user_id,
  }
  let promoted = false
  if (user.email_verified_at && user.verification_level < codeRow.verification_level) {
    updates.verification_level = codeRow.verification_level
    promoted = true
  }
  await db.updateUser(c.env.DB, user.id, updates)

  const updated = await db.getUserById(c.env.DB, user.id)
  return c.json({
    message: promoted
      ? 'Invite redeemed; you are now verified'
      : 'Invite recorded; verify your email to complete promotion',
    user: updated ? userRowToApi(updated) : null,
  })
})

app.post('/auth/complete-onboarding', authMiddleware, async (c) => {
  try {
    const user = c.get('user')
    const body = await c.req.json<{
      firstName?: string
      lastName?: string
      dateOfBirth?: string
      centerID?: string
      profileComplete?: boolean
      phoneNumber?: string
      interests?: string[]
    }>()

    const updates: Partial<UserRow> = {}
    if (body.firstName !== undefined) updates.first_name = body.firstName
    if (body.lastName !== undefined) updates.last_name = body.lastName
    if (body.dateOfBirth !== undefined) updates.date_of_birth = body.dateOfBirth
    // Skip center_id if empty string (no center selected during onboarding)
    if (body.centerID) updates.center_id = body.centerID
    if (body.profileComplete !== undefined) updates.profile_complete = body.profileComplete ? 1 : 0
    if (body.phoneNumber !== undefined) updates.phone_number = body.phoneNumber
    if (body.interests !== undefined) updates.interests = JSON.stringify(body.interests)

    const result = await db.updateUser(c.env.DB, user.id, updates)

    if (result.success) {
      const updated = await db.getUserById(c.env.DB, user.id)
      return c.json({
        message: 'Profile completed successfully',
        user: updated ? userRowToApi(updated) : null,
      })
    }

    return c.json({ message: 'Failed to update profile', error: result.error }, 500)
  } catch (err: any) {
    console.error('complete-onboarding error:', err)
    return c.json({ message: 'Failed to complete onboarding' }, 500)
  }
})

app.put('/auth/update-profile', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{
    firstName?: string
    lastName?: string
    email?: string
    centerID?: string
    profileComplete?: boolean
    profileImage?: string
    bio?: string
    phoneNumber?: string
    interests?: string[]
    dateOfBirth?: string
    // Minimal profile fields (#210)
    school?: string
    work?: string
    region?: string
    lookingFor?: string[]
  }>()

  const updates: Partial<UserRow> = {}
  if (body.firstName !== undefined) updates.first_name = body.firstName
  if (body.lastName !== undefined) updates.last_name = body.lastName
  if (body.email !== undefined) updates.email = body.email
  if (body.dateOfBirth !== undefined) updates.date_of_birth = body.dateOfBirth
  // Coerce empty string to null (allowed by FK), reject non-existent center IDs naturally
  if (body.centerID !== undefined) updates.center_id = body.centerID || null
  if (body.profileComplete !== undefined) updates.profile_complete = body.profileComplete ? 1 : 0
  if (body.profileImage !== undefined) updates.profile_image = body.profileImage
  if (body.bio !== undefined) updates.bio = body.bio || null
  if (body.phoneNumber !== undefined) updates.phone_number = body.phoneNumber
  if (body.interests !== undefined) updates.interests = JSON.stringify(body.interests)
  // Minimal profile fields. Empty strings become null so the API never
  // exposes a field the user didn't fill in.
  if (body.school !== undefined) updates.school = body.school?.trim() || null
  if (body.work !== undefined) updates.work = body.work?.trim() || null
  if (body.region !== undefined) updates.region = body.region?.trim() || null
  if (body.lookingFor !== undefined) {
    updates.looking_for = body.lookingFor.length > 0 ? JSON.stringify(body.lookingFor) : null
  }

  const result = await db.updateUser(c.env.DB, user.id, updates)

  if (result.success) {
    const updated = await db.getUserById(c.env.DB, user.id)
    return c.json({
      message: 'Profile updated',
      user: updated ? userRowToApi(updated) : null,
    })
  }

  return c.json({ message: 'Failed to update profile', error: result.error }, 500)
})

app.delete('/auth/delete-account', authMiddleware, async (c) => {
  const user = c.get('user')
  const result = await db.deleteUser(c.env.DB, user.id)

  if (result.success) {
    return c.json({ message: 'Account deleted successfully' })
  }

  return c.json({ message: 'Failed to delete account', error: result.error }, 500)
})

// Legacy auth routes (backward compatibility)
app.post('/register', rateLimit(10, 60_000), async (c) => {
  // Forward to the new route handler
  const body = await c.req.json()
  const url = new URL(c.req.url)
  url.pathname = '/api/auth/register'
  const newReq = new Request(url.toString(), {
    method: 'POST',
    headers: c.req.raw.headers,
    body: JSON.stringify(body),
  })
  return app.fetch(newReq, c.env)
})

app.post('/authenticate', rateLimit(10, 60_000), async (c) => {
  const body = await c.req.json()
  const url = new URL(c.req.url)
  url.pathname = '/api/auth/authenticate'
  const newReq = new Request(url.toString(), {
    method: 'POST',
    headers: c.req.raw.headers,
    body: JSON.stringify(body),
  })
  return app.fetch(newReq, c.env)
})

app.post('/deauthenticate', (c) => {
  return c.json({ message: 'Deauthentication successful!' })
})

// ═══════════════════════════════════════════════════════════════════════
// CENTER ROUTES
// ═══════════════════════════════════════════════════════════════════════

app.get('/centers', cacheControl(30), async (c) => {
  // Pagination (#107). Backwards-compatible: when no `limit` is provided we
  // return the entire centers list as before (matches the legacy clients).
  // When `limit` is set, return `{ centers, total, limit, offset }`.
  const limitParam = c.req.query('limit')
  if (limitParam == null) {
    const centers = await db.getAllCenters(c.env.DB)
    return c.json({ centers: centers.map(centerRowToApi) })
  }
  const limit = Number.parseInt(limitParam, 10)
  const offset = Number.parseInt(c.req.query('offset') ?? '0', 10)
  if (!Number.isFinite(limit) || limit < 1) {
    return c.json({ message: 'limit must be a positive integer' }, 400)
  }
  if (!Number.isFinite(offset) || offset < 0) {
    return c.json({ message: 'offset must be >= 0' }, 400)
  }
  const { data, total } = await db.getCentersPaginated(c.env.DB, limit, offset)
  return c.json({
    centers: data.map(centerRowToApi),
    total,
    limit: Math.min(limit, 200),
    offset,
  })
})

app.post('/addCenter', authMiddleware, async (c) => {
  const body = await c.req.json<{
    latitude: number
    longitude: number
    centerName: string
    address?: string
    website?: string
    phone?: string
    image?: string
    acharya?: string
    pointOfContact?: string
  }>()

  const validName = validate.centerName(body.centerName)
  if (!validName) {
    return c.json({ message: 'centerName is required (max 100 characters)' }, 400)
  }

  const lat = typeof body.latitude === 'number' ? body.latitude : NaN
  const lng = typeof body.longitude === 'number' ? body.longitude : NaN
  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return c.json(
      { message: 'Valid latitude (-90..90) and longitude (-180..180) are required' },
      400
    )
  }

  const id = crypto.randomUUID()
  const result = await db.createCenter(c.env.DB, {
    id,
    name: validName,
    latitude: lat,
    longitude: lng,
    address: body.address ?? null,
    website: body.website ?? null,
    phone: body.phone ?? null,
    image: body.image ?? null,
    acharya: body.acharya ?? null,
    point_of_contact: body.pointOfContact ?? null,
  })

  if (!result.success) {
    return c.json({ message: 'Internal server error OR center ID not unique' }, 500)
  }

  return c.json({ message: 'Operation successful', id })
})

app.post('/verifyCenter', authMiddleware, async (c) => {
  const user = c.get('user')
  if (!isAdmin(user)) {
    return c.json({ message: 'User is not authorized to verify or verification failed.' }, 401)
  }

  const { centerID } = await c.req.json<{ centerID: string }>()
  const center = await db.getCenterById(c.env.DB, centerID)
  if (!center) {
    return c.json({ message: 'Center not found' }, 404)
  }

  const result = await db.updateCenter(c.env.DB, centerID, {
    is_verified: 1,
  })

  if (result.success) {
    return c.json({ message: 'Successful verification!' })
  }
  return c.json({ message: 'Verification failed' }, 500)
})

app.post('/removeCenter', authMiddleware, async (c) => {
  const user = c.get('user')
  if (!isAdmin(user)) {
    return c.json({ message: 'Insufficient permissions' }, 401)
  }

  const { centerID } = await c.req.json<{ centerID: string }>()
  const result = await db.deleteCenter(c.env.DB, centerID)

  if (result.success) {
    return c.json({ message: 'Successful removal!' })
  }
  return c.json({ message: 'Removal failed' }, 500)
})

app.post('/fetchAllCenters', async (c) => {
  const centers = await db.getAllCenters(c.env.DB)
  return c.json({
    message: 'Successful',
    centersList: centers.map(centerRowToApi),
  })
})

app.post('/fetchCenter', async (c) => {
  const { centerID } = await c.req.json<{ centerID: string }>()
  if (!centerID) {
    return c.json({ message: 'Malformed centerID' }, 400)
  }

  const center = await db.getCenterById(c.env.DB, centerID)
  if (!center) {
    return c.json({ message: 'Center not found' }, 404)
  }

  return c.json({ message: 'Success', center: centerRowToApi(center) })
})

// GET alias of /fetchCenter (#125). Cloudflare only edge-caches GET, so
// adding the alias lets the same data be served from 300+ POPs with 30s
// staleness. POST stays for backward compat with existing clients.
app.get('/fetchCenter', cacheControl(30), async (c) => {
  const centerID = c.req.query('centerID')
  if (!centerID) {
    return c.json({ message: 'Malformed centerID' }, 400)
  }
  const center = await db.getCenterById(c.env.DB, centerID)
  if (!center) {
    return c.json({ message: 'Center not found' }, 404)
  }
  return c.json({ message: 'Success', center: centerRowToApi(center) })
})

// ═══════════════════════════════════════════════════════════════════════
// USER ROUTES
// ═══════════════════════════════════════════════════════════════════════

app.post('/verifyUser', authMiddleware, async (c) => {
  const adminUser = c.get('user')
  if (!isAdmin(adminUser)) {
    return c.json({ message: 'Insufficient permission to authorize.' }, 401)
  }

  const { usernameToVerify, verificationLevel } = await c.req.json<{
    usernameToVerify: string
    verificationLevel: number
  }>()

  const targetUser = await db.getUserByUsername(c.env.DB, usernameToVerify)
  if (!targetUser) {
    return c.json({ message: 'User not found.' }, 404)
  }

  const result = await db.updateUser(c.env.DB, targetUser.id, {
    is_verified: 1,
    verification_level: verificationLevel,
  })

  if (result.success) {
    return c.json({ message: 'Verification successful.' })
  }
  return c.json({ message: 'Verification failed.' }, 500)
})

app.post('/userUpdate', authMiddleware, async (c) => {
  const user = c.get('user')
  if (!isAdmin(user)) {
    return c.json({ message: 'Insufficient permissions' }, 401)
  }

  const { username, userJSON } = await c.req.json<{
    username: string
    userJSON: any
  }>()

  const targetUser = await db.getUserByUsername(c.env.DB, username)
  if (!targetUser) {
    return c.json({ message: 'User not found.' }, 404)
  }

  // Map the legacy userJSON fields to D1 column names
  const updates: Partial<UserRow> = {}
  if (userJSON.firstName !== undefined) updates.first_name = userJSON.firstName
  if (userJSON.lastName !== undefined) updates.last_name = userJSON.lastName
  if (userJSON.dateOfBirth !== undefined) updates.date_of_birth = userJSON.dateOfBirth
  if (userJSON.profilePictureURL !== undefined) updates.profile_image = userJSON.profilePictureURL
  if (userJSON.center !== undefined)
    updates.center_id = userJSON.center === -1 ? null : String(userJSON.center)
  if (userJSON.points !== undefined) updates.points = userJSON.points
  if (userJSON.isVerified !== undefined) updates.is_verified = userJSON.isVerified ? 1 : 0
  if (userJSON.verificationLevel !== undefined)
    updates.verification_level = userJSON.verificationLevel
  if (userJSON.isActive !== undefined) updates.is_active = userJSON.isActive ? 1 : 0

  const result = await db.updateUser(c.env.DB, targetUser.id, updates)

  if (result.success) {
    return c.json({ message: 'Operation successful.' })
  }
  return c.json({ message: 'Update failed.' }, 400)
})

app.post('/updateRegistration', authMiddleware, async (c) => {
  const user = c.get('user')
  const { username, userJSON } = await c.req.json<{
    username: string
    userJSON: any
  }>()

  if (user.username !== username && !isAdmin(user)) {
    return c.json({ message: 'Insufficient permissions' }, 401)
  }

  const targetUser = await db.getUserByUsername(c.env.DB, username)
  if (!targetUser) {
    return c.json({ message: 'Update failed' }, 400)
  }

  const updates: Partial<UserRow> = {}
  if (userJSON.firstName !== undefined) updates.first_name = userJSON.firstName
  if (userJSON.lastName !== undefined) updates.last_name = userJSON.lastName
  if (userJSON.dateOfBirth !== undefined) updates.date_of_birth = userJSON.dateOfBirth
  if (userJSON.center !== undefined)
    updates.center_id = userJSON.center === -1 ? null : String(userJSON.center)

  const result = await db.updateUser(c.env.DB, targetUser.id, updates)

  if (result.success) {
    return c.json({ message: 'User updated' })
  }
  return c.json({ message: 'Update failed' }, 400)
})

app.post('/removeUser', authMiddleware, async (c) => {
  const user = c.get('user')
  if (!isAdmin(user)) {
    return c.json({ message: 'Insufficient permissions' }, 401)
  }

  const { username } = await c.req.json<{ username: string }>()
  const targetUser = await db.getUserByUsername(c.env.DB, username)
  if (!targetUser) {
    return c.json({ message: 'Removal failed' }, 400)
  }

  const result = await db.deleteUser(c.env.DB, targetUser.id)
  if (result.success) {
    return c.json({ message: 'User removed' })
  }
  return c.json({ message: 'Removal failed' }, 400)
})

app.post('/getUserEvents', authMiddleware, async (c) => {
  const { username } = await c.req.json<{ username: string }>()
  const targetUser = await db.getUserByUsername(c.env.DB, username)
  if (!targetUser) {
    return c.json({ message: 'User not found' }, 404)
  }

  const events = await db.getUserEvents(c.env.DB, targetUser.id)
  return c.json({
    message: 'Success',
    events: events.map(eventRowToApi),
  })
})

// ═══════════════════════════════════════════════════════════════════════
// PROFILE ROUTES
// ═══════════════════════════════════════════════════════════════════════

app.get('/public-profiles/:userId', authMiddleware, async (c) => {
  const userId = c.req.param('userId')
  const targetUser = await db.getUserById(c.env.DB, userId)
  if (!targetUser) return c.json({ message: 'User not found' }, 404)

  const center = targetUser.center_id
    ? await db.getCenterById(c.env.DB, targetUser.center_id)
    : null
  const hostedEvents = await db.getUserCreatedEvents(c.env.DB, targetUser.id)

  return c.json({
    profile: userRowToPublicProfile(
      targetUser,
      center?.name ?? null,
      hostedEvents.map(eventRowToApi),
    ),
  })
})

app.get('/profile/:username/events', authMiddleware, async (c) => {
  const { username } = c.req.param()
  const targetUser = await db.getUserByUsername(c.env.DB, username)
  if (!targetUser) return c.json({ message: 'User not found' }, 404)
  const events = await db.getUserEvents(c.env.DB, targetUser.id)
  return c.json({ events: events.map(eventRowToApi) })
})

app.get('/profile/:username/posts', authMiddleware, async (c) => {
  const { username } = c.req.param()
  const targetUser = await db.getUserByUsername(c.env.DB, username)
  if (!targetUser) return c.json({ message: 'User not found' }, 404)
  const posts = await db.getUserCreatedEvents(c.env.DB, targetUser.id)
  return c.json({ posts: posts.map(eventRowToApi) })
})

app.get('/profile/:username/groups', authMiddleware, async (c) => {
  const { username } = c.req.param()
  const targetUser = await db.getUserByUsername(c.env.DB, username)
  if (!targetUser) return c.json({ message: 'User not found' }, 404)
  const groups = targetUser.center_id
    ? [centerRowToApi(await db.getCenterById(c.env.DB, targetUser.center_id) as any)]
    : []
  return c.json({ groups: groups.filter(Boolean) })
})

app.get('/profile/:username/messages', authMiddleware, async (_c) => {
  // Messaging not yet implemented — reserved for future use
  return _c.json({ messages: [], total: 0 })
})

// ═══════════════════════════════════════════════════════════════════════
// BOARD ROUTES
// ═══════════════════════════════════════════════════════════════════════

app.get('/boards/:type/:id', authMiddleware, async (c) => {
  const user = c.get('user')
  const typeParam = c.req.param('type')
  const parentId = c.req.param('id')

  if (!isBoardType(typeParam)) {
    return c.json({ message: 'Board type must be center or event' }, 400)
  }

  const accessError = await verifyBoardAccess(c, typeParam, parentId, user)
  if (accessError) return accessError

  const limit = Number.parseInt(c.req.query('limit') || '50', 10)
  const offset = Number.parseInt(c.req.query('offset') || '0', 10)
  const board = await db.ensureBoard(c.env.DB, typeParam, parentId)
  const posts = await db.listBoardPosts(c.env.DB, board.id, { limit, offset })

  return c.json({
    board: boardRowToApi(board),
    posts: posts.map(boardPostToApi),
  })
})

app.post('/boards/:type/:id/posts', authMiddleware, async (c) => {
  const user = c.get('user')
  const typeParam = c.req.param('type')
  const parentId = c.req.param('id')

  if (!isBoardType(typeParam)) {
    return c.json({ message: 'Board type must be center or event' }, 400)
  }

  const accessError = await verifyBoardAccess(c, typeParam, parentId, user)
  if (accessError) return accessError

  const suspended = suspendedPostingResponse(c, user)
  if (suspended) return suspended

  const body: { body?: string; imageUrl?: string | null } = await c.req
    .json<{ body?: string; imageUrl?: string | null }>()
    .catch(() => ({}))
  const text = typeof body.body === 'string' ? body.body.trim() : ''
  if (!text) {
    return c.json({ message: 'Post body is required' }, 400)
  }
  if (text.length > 2000) {
    return c.json({ message: 'Post body must be 2000 characters or fewer' }, 400)
  }

  const imageUrl = body.imageUrl ?? null
  const validImageUrl = validate.url(imageUrl || undefined)
  if (validImageUrl === false) {
    return c.json({ message: 'Image URL is invalid' }, 400)
  }

  const board = await db.ensureBoard(c.env.DB, typeParam, parentId)
  const postId = crypto.randomUUID()
  const created = await db.createBoardPost(c.env.DB, {
    id: postId,
    board_id: board.id,
    author_id: user.id,
    body: text,
    image_url: validImageUrl ?? null,
  })

  if (!created.success) {
    console.error('createBoardPost error:', created.error)
    return c.json({ message: 'Failed to create board post' }, 500)
  }

  const posts = await db.listBoardPosts(c.env.DB, board.id, { limit: 1 })
  const post = posts.find((candidate) => candidate.id === postId)
  if (!post) {
    return c.json({ message: 'Board post created but could not be loaded' }, 500)
  }

  // Fan out BOARD_POST to everyone on this board (except the author).
  fireNotify(
    c,
    (async () => {
      const recipientIds = await db.getBoardRecipientIds(c.env.DB, typeParam, parentId)
      const authorName = displayName(user)
      const where =
        typeParam === 'event' ? 'an event you’re attending' : 'your center board'
      await push.dispatchNotification(
        c.env,
        recipientIds,
        notifications.NOTIFICATION_TYPES.BOARD_POST,
        `${authorName} posted in ${where}`,
        preview(text),
        {
          excludeUserId: user.id,
          actionUrl: `/feed/${postId}`,
          relatedUserId: user.id,
          data: { boardType: typeParam, parentId, postId },
        },
      )
    })(),
  )

  return c.json({ post: boardPostToApi(post) }, 201)
})

app.post('/feed/public', authMiddleware, async (c) => {
  const user = c.get('user')

  const suspended = suspendedPostingResponse(c, user)
  if (suspended) return suspended

  const body: { body?: string; imageUrl?: string | null } = await c.req
    .json<{ body?: string; imageUrl?: string | null }>()
    .catch(() => ({}))
  const text = typeof body.body === 'string' ? body.body.trim() : ''
  if (!text) {
    return c.json({ message: 'Post body is required' }, 400)
  }
  if (text.length > 2000) {
    return c.json({ message: 'Post body must be 2000 characters or fewer' }, 400)
  }

  const imageUrl = body.imageUrl ?? null
  const validImageUrl = validate.url(imageUrl || undefined)
  if (validImageUrl === false) {
    return c.json({ message: 'Image URL is invalid' }, 400)
  }

  const postId = crypto.randomUUID()
  const created = await db.createBoardPost(c.env.DB, {
    id: postId,
    board_id: null,
    author_id: user.id,
    body: text,
    image_url: validImageUrl ?? null,
    visibility: 'public_signed_in',
  })

  if (!created.success) {
    console.error('createPublicPost error:', created.error)
    return c.json({ message: 'Failed to create public post' }, 500)
  }

  const post = await db.getBoardPostWithAuthorById(c.env.DB, postId)
  if (!post) {
    return c.json({ message: 'Public post created but could not be loaded' }, 500)
  }

  return c.json({ post: boardPostToApi(post) }, 201)
})

app.post('/boards/posts/:postId/reactions', authMiddleware, async (c) => {
  const user = c.get('user')
  const postId = c.req.param('postId')
  const post = await db.getBoardPostById(c.env.DB, postId)
  if (!post) {
    return c.json({ message: 'Board post not found' }, 404)
  }

  let board: Awaited<ReturnType<typeof db.getBoardById>> = null
  if (post.board_id !== null) {
    board = await db.getBoardById(c.env.DB, post.board_id)
    if (!board) {
      return c.json({ message: 'Board not found' }, 404)
    }

    const accessError = await verifyBoardAccess(c, board.type, board.parent_id, user)
    if (accessError) return accessError
  }

  const body: { emoji?: string } = await c.req.json<{ emoji?: string }>().catch(() => ({}))
  if (!body.emoji || !BOARD_REACTIONS.has(body.emoji)) {
    return c.json({ message: 'Reaction emoji is not allowed' }, 400)
  }

  const result = await db.toggleBoardPostReaction(c.env.DB, post.id, user.id, body.emoji)

  // Only notify when a reaction is ADDED (not on un-react), and never the
  // author reacting to their own post (BOARD_REACTION).
  if (result.active && post.author_id !== user.id) {
    fireNotify(
      c,
      push.dispatchNotification(
        c.env,
        [post.author_id],
        notifications.NOTIFICATION_TYPES.BOARD_REACTION,
        `${displayName(user)} reacted ${body.emoji} to your post`,
        preview(post.body),
        {
          excludeUserId: user.id,
          actionUrl: `/feed/${post.id}`,
          relatedUserId: user.id,
          data: board
            ? { boardType: board.type, parentId: board.parent_id, postId: post.id }
            : { boardType: 'public', parentId: 'public', postId: post.id },
        },
      ),
    )
  }

  return c.json(result)
})

// Edit a post body. Author only; only within BOARD_POST_EDIT_WINDOW_MS of
// creation; soft-deleted posts can't be edited.
app.patch('/boards/posts/:postId', authMiddleware, async (c) => {
  const user = c.get('user')
  const postId = c.req.param('postId')

  // Need the post to enforce access (the board the post belongs to) — we use
  // the same membership/RSVP gate as posting. Include deleted rows so we
  // can return 410 Gone instead of 404 for already-deleted posts.
  const post = await db.getBoardPostByIdIncludingDeleted(c.env.DB, postId)
  if (!post) {
    return c.json({ message: 'Board post not found' }, 404)
  }
  if (post.board_id !== null) {
    const board = await db.getBoardById(c.env.DB, post.board_id)
    if (!board) {
      return c.json({ message: 'Board not found' }, 404)
    }
    const accessError = await verifyBoardAccess(c, board.type, board.parent_id, user)
    if (accessError) return accessError
  }

  const body: { body?: string } = await c.req
    .json<{ body?: string }>()
    .catch(() => ({}))
  const text = typeof body.body === 'string' ? body.body.trim() : ''
  if (!text) {
    return c.json({ message: 'Post body is required' }, 400)
  }
  if (text.length > 2000) {
    return c.json({ message: 'Post body must be 2000 characters or fewer' }, 400)
  }

  const result = await db.editBoardPost(c.env.DB, postId, user.id, text)
  if (!result.ok) {
    switch (result.reason) {
      case 'not_found':
        return c.json({ message: 'Board post not found' }, 404)
      case 'deleted':
        return c.json({ message: 'Cannot edit a deleted post' }, 410)
      case 'not_author':
        return c.json({ message: 'Only the author can edit this post' }, 403)
      case 'window_expired':
        return c.json(
          { message: 'Edit window has expired (posts are editable for 5 minutes after creation)' },
          409,
        )
    }
  }

  // Return the updated post in the same shape as the create response.
  const updated = post.board_id === null
    ? await db.getBoardPostWithAuthorById(c.env.DB, postId)
    : (await db.listBoardPosts(c.env.DB, post.board_id, { limit: 100 }))
        .find((p) => p.id === postId)
  if (!updated) {
    return c.json({ message: 'Post edited but could not be reloaded' }, 500)
  }
  return c.json({ post: boardPostToApi(updated) })
})

// Soft-delete a post. Author or admin only. The row stays in the table
// so M1 (moderation) can still surface it; listBoardPosts already filters
// deleted_at IS NULL.
app.delete('/boards/posts/:postId', authMiddleware, async (c) => {
  const user = c.get('user')
  const postId = c.req.param('postId')

  // Include deleted rows so we can return 410 Gone for an already-deleted post.
  const post = await db.getBoardPostByIdIncludingDeleted(c.env.DB, postId)
  if (!post) {
    return c.json({ message: 'Board post not found' }, 404)
  }
  if (post.board_id !== null) {
    const board = await db.getBoardById(c.env.DB, post.board_id)
    if (!board) {
      return c.json({ message: 'Board not found' }, 404)
    }
    // Read access (deletion gate is finer-grained inside softDeleteBoardPost,
    // but we still want to 403 non-members of the board)
    const accessError = await verifyBoardAccess(c, board.type, board.parent_id, user)
    if (accessError) return accessError
  }

  const result = await db.softDeleteBoardPost(c.env.DB, postId, {
    id: user.id,
    isAdmin: isAdmin(user),
  })
  if (!result.ok) {
    switch (result.reason) {
      case 'not_found':
        return c.json({ message: 'Board post not found' }, 404)
      case 'already_deleted':
        return c.json({ message: 'Post is already deleted' }, 410)
      case 'forbidden':
        return c.json(
          { message: 'Only the author or an admin can delete this post' },
          403,
        )
    }
  }

  return c.json({ ok: true })
})

// Pin a board post. Per PRD §5.2 + #205: "Posts can be pinned by board
// admins (sevak / center admin); pinned posts sort first." Gate: caller
// must be SEVAK or higher (which includes Brahmachari and Admin tiers),
// OR a global admin. listBoardPosts ORDER BY puts pinned first.
app.post('/boards/posts/:postId/pin', authMiddleware, async (c) => {
  const user = c.get('user')
  const postId = c.req.param('postId')

  const post = await db.getBoardPostById(c.env.DB, postId)
  if (!post) {
    return c.json({ message: 'Board post not found' }, 404)
  }
  if (post.board_id === null) {
    return c.json({ message: 'Public posts cannot be pinned' }, 409)
  }
  const board = await db.getBoardById(c.env.DB, post.board_id)
  if (!board) {
    return c.json({ message: 'Board not found' }, 404)
  }

  // Read-side gate (must have access to the board at all)
  const accessError = await verifyBoardAccess(c, board.type, board.parent_id, user)
  if (accessError) return accessError

  // Pin authority gate
  if (user.verification_level < SEVAK && !isAdmin(user)) {
    return c.json(
      { message: 'Only sevaks, brahmacharis, or admins can pin posts' },
      403,
    )
  }

  const result = await db.pinBoardPost(c.env.DB, postId, user.id)
  if (!result.ok) {
    switch (result.reason) {
      case 'not_found':
        return c.json({ message: 'Board post not found' }, 404)
      case 'deleted':
        return c.json({ message: 'Cannot pin a deleted post' }, 410)
      case 'already_pinned':
        return c.json({ message: 'Post is already pinned' }, 409)
    }
  }

  return c.json({ ok: true, pinned: true })
})

app.post('/boards/posts/:postId/unpin', authMiddleware, async (c) => {
  const user = c.get('user')
  const postId = c.req.param('postId')

  const post = await db.getBoardPostById(c.env.DB, postId)
  if (!post) {
    return c.json({ message: 'Board post not found' }, 404)
  }
  if (post.board_id === null) {
    return c.json({ message: 'Public posts cannot be unpinned' }, 409)
  }
  const board = await db.getBoardById(c.env.DB, post.board_id)
  if (!board) {
    return c.json({ message: 'Board not found' }, 404)
  }
  const accessError = await verifyBoardAccess(c, board.type, board.parent_id, user)
  if (accessError) return accessError

  if (user.verification_level < SEVAK && !isAdmin(user)) {
    return c.json(
      { message: 'Only sevaks, brahmacharis, or admins can unpin posts' },
      403,
    )
  }

  const result = await db.unpinBoardPost(c.env.DB, postId)
  if (!result.ok) {
    switch (result.reason) {
      case 'not_found':
        return c.json({ message: 'Board post not found' }, 404)
      case 'deleted':
        return c.json({ message: 'Cannot unpin a deleted post' }, 410)
      case 'not_pinned':
        return c.json({ message: 'Post is not currently pinned' }, 409)
    }
  }

  return c.json({ ok: true, pinned: false })
})

// Single-level threaded replies (#205). Access gate: same as posting on the
// parent's board. Replies inherit the parent's board so users RSVP'd or
// center-verified for that board can reply.
app.post('/boards/posts/:postId/replies', authMiddleware, async (c) => {
  const user = c.get('user')
  const parentPostId = c.req.param('postId')

  const parent = await db.getBoardPostById(c.env.DB, parentPostId)
  if (!parent) {
    return c.json({ message: 'Board post not found' }, 404)
  }
  let board: Awaited<ReturnType<typeof db.getBoardById>> = null
  if (parent.board_id !== null) {
    board = await db.getBoardById(c.env.DB, parent.board_id)
    if (!board) {
      return c.json({ message: 'Board not found' }, 404)
    }
    const accessError = await verifyBoardAccess(c, board.type, board.parent_id, user)
    if (accessError) return accessError
  }

  const suspended = suspendedPostingResponse(c, user)
  if (suspended) return suspended

  const body: { body?: string } = await c.req
    .json<{ body?: string }>()
    .catch(() => ({}))
  const text = typeof body.body === 'string' ? body.body.trim() : ''
  if (!text) {
    return c.json({ message: 'Reply body is required' }, 400)
  }
  if (text.length > 2000) {
    return c.json({ message: 'Reply body must be 2000 characters or fewer' }, 400)
  }

  const replyId = crypto.randomUUID()
  const result = await db.createBoardPostReply(c.env.DB, {
    id: replyId,
    parent_post_id: parentPostId,
    board_id: parent.board_id,
    author_id: user.id,
    body: text,
  })

  if (!result.ok) {
    switch (result.reason) {
      case 'parent_not_found':
        return c.json({ message: 'Parent post not found' }, 404)
      case 'parent_deleted':
        return c.json({ message: 'Cannot reply to a deleted post' }, 410)
      case 'parent_is_reply':
        return c.json(
          { message: 'Cannot reply to a reply — threads are single-level only in v2' },
          409,
        )
      case 'insert_failed':
        return c.json({ message: 'Failed to create reply' }, 500)
    }
  }

  // Reload via the listBoardPostReplies path so the returned shape matches
  // the GET endpoint and the frontend sees consistent fields.
  const replies = await db.listBoardPostReplies(c.env.DB, parentPostId)
  const created = replies.find((r) => r.id === replyId)
  if (!created) {
    return c.json({ message: 'Reply created but could not be loaded' }, 500)
  }

  // Notify the parent post's author that someone replied (BOARD_REPLY).
  fireNotify(
    c,
    push.dispatchNotification(
      c.env,
      [parent.author_id],
      notifications.NOTIFICATION_TYPES.BOARD_REPLY,
      `${displayName(user)} replied to your post`,
      preview(text),
      {
        excludeUserId: user.id,
        actionUrl: `/feed/${parentPostId}`,
        relatedUserId: user.id,
        data: board
          ? { boardType: board.type, parentId: board.parent_id, postId: parentPostId }
          : { boardType: 'public', parentId: 'public', postId: parentPostId },
      },
    ),
  )

  return c.json({ reply: boardPostToApi(created) }, 201)
})

app.get('/boards/posts/:postId/replies', authMiddleware, async (c) => {
  const user = c.get('user')
  const parentPostId = c.req.param('postId')

  const parent = await db.getBoardPostById(c.env.DB, parentPostId)
  if (!parent) {
    return c.json({ message: 'Board post not found' }, 404)
  }
  if (parent.board_id !== null) {
    const board = await db.getBoardById(c.env.DB, parent.board_id)
    if (!board) {
      return c.json({ message: 'Board not found' }, 404)
    }
    const accessError = await verifyBoardAccess(c, board.type, board.parent_id, user)
    if (accessError) return accessError
  }

  const replies = await db.listBoardPostReplies(c.env.DB, parentPostId)
  return c.json({
    replies: replies.map(boardPostToApi),
  })
})

/**
 * Aggregated cross-board feed (#205). Returns every top-level post on a
 * board the authenticated user has access to (verified center member:
 * posts on that center's board; event-attendee: posts on those event
 * boards), in reverse-chronological order. Replies are excluded from this
 * top-level feed. Per #205: target latency <300ms on production data.
 */
app.get('/feed', authMiddleware, async (c) => {
  const user = c.get('user')
  const limit = Number.parseInt(c.req.query('limit') || '50', 10)
  const offset = Number.parseInt(c.req.query('offset') || '0', 10)

  const posts = await db.listAggregatedFeed(
    c.env.DB,
    {
      id: user.id,
      center_id: user.center_id,
    },
    { limit, offset },
  )

  return c.json({
    posts: posts.map(boardPostToApi),
  })
})

/**
 * Report a board post for moderation (#209). Any verified user can report;
 * one report per (post, reporter) — re-reporting updates the reason. The
 * report lands in the admin moderation queue.
 */
app.post('/boards/posts/:postId/report', authMiddleware, rateLimit(10, 60_000), async (c) => {
  const user = c.get('user')
  // Authenticated-only (rate-limited). We deliberately do NOT add a stricter
  // verification gate than posting itself enforces — board posting checks
  // center/event membership, not verification_level, so reporting matches.
  const postId = c.req.param('postId')

  // Allow reporting deleted posts too (a report may arrive just after a
  // delete); use the including-deleted lookup so we 404 only for non-existent.
  const post = await db.getBoardPostByIdIncludingDeleted(c.env.DB, postId)
  if (!post) {
    return c.json({ message: 'Board post not found' }, 404)
  }

  const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string })
  let reason: string | null = typeof body.reason === 'string' ? body.reason.trim() : null
  if (reason && reason.length > 500) reason = reason.slice(0, 500)
  if (reason === '') reason = null

  const result = await db.createPostReport(c.env.DB, {
    id: crypto.randomUUID(),
    postId,
    reporterId: user.id,
    reason,
  })
  if (!result.success) {
    console.error('createPostReport error:', result.error)
    return c.json({ message: 'Failed to submit report' }, 500)
  }
  return c.json({ message: 'Report submitted' }, 201)
})

// ═══════════════════════════════════════════════════════════════════════
// EVENT ROUTES
// ═══════════════════════════════════════════════════════════════════════

app.post('/addEvent', authMiddleware, async (c) => {
  const user = c.get('user')

  // Event creation is coordinator-gated: only sevak-and-above (or a global
  // admin) can create events. Beta coordinators (e.g. SJ/Dallas pilots) are
  // provisioned at SEVAK; they invite normal members to their center.
  if (!isAdmin(user) && (user.verification_level ?? 0) < SEVAK) {
    return c.json({ message: 'Only coordinators can create events' }, 403)
  }

  const data = await c.req.json<{
    title?: string
    description?: string
    latitude: number
    longitude: number
    address?: string
    date: string
    centerID: string
    endorsers?: string[]
    pointOfContact?: string
    image?: string
    category?: number
    externalUrl?: string | null
    signupUrl?: string | null
    allowJanataSignup?: boolean
  }>()

  // Validate required fields
  const validCenterID = validate.id(data.centerID)
  if (!validCenterID) {
    return c.json({ message: 'Valid centerID is required' }, 400)
  }

  if (!data.date || typeof data.date !== 'string') {
    return c.json({ message: 'date is required' }, 400)
  }

  const lat = typeof data.latitude === 'number' ? data.latitude : NaN
  const lng = typeof data.longitude === 'number' ? data.longitude : NaN
  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return c.json(
      { message: 'Valid latitude (-90..90) and longitude (-180..180) are required' },
      400
    )
  }

  // Validate optional string fields (false = exceeded max length)
  const validTitle = validate.title(data.title)
  const validDescription = validate.description(data.description)
  const validAddress = validate.address(data.address)
  const validImage = validate.url(data.image)

  if (
    validTitle === false ||
    validDescription === false ||
    validAddress === false ||
    validImage === false
  ) {
    return c.json({ message: 'One or more fields exceed maximum length' }, 400)
  }

  // Validate center exists
  const center = await db.getCenterById(c.env.DB, validCenterID)
  if (!center) {
    return c.json({ message: 'Center not found.' }, 404)
  }

  const eventId = crypto.randomUUID()

  const validExternalUrl = validate.url(data.externalUrl)
  const validSignupUrl = validate.url(data.signupUrl)
  if (validExternalUrl === false || validSignupUrl === false) {
    return c.json({ message: 'External URL or signup URL is invalid' }, 400)
  }

  // #192 — auto-mark "official" when the creator's verification_level was
  // SEVAK (54) or higher at create time. Snapshot value; no backfill on
  // future level changes. Frontend renders a verified-check badge.
  const isOfficial = (user.verification_level ?? 0) >= SEVAK ? 1 : 0

  const result = await db.createEvent(c.env.DB, {
    id: eventId,
    title: validTitle ?? '',
    description: validDescription ?? '',
    date: data.date,
    latitude: lat,
    longitude: lng,
    address: validAddress ?? null,
    center_id: validCenterID,
    point_of_contact: data.pointOfContact ?? null,
    image: validImage ?? null,
    category: data.category ?? null,
    external_url: validExternalUrl ?? null,
    signup_url: validSignupUrl ?? null,
    allow_janata_signup: data.allowJanataSignup ? 1 : 0,
    is_official: isOfficial,
    created_by: user.id,
  })

  if (!result.success) {
    return c.json({ message: 'Failed to store event.' }, 500)
  }

  // Add endorsers
  if (data.endorsers && data.endorsers.length > 0) {
    for (const endorserUsername of data.endorsers) {
      const endorserUser = await db.getUserByUsername(c.env.DB, endorserUsername)
      if (endorserUser && endorserUser.verification_level >= SEVAK) {
        await db.addEventEndorser(c.env.DB, eventId, endorserUser.id)
        // Also add as attendee
        await db.addEventAttendee(c.env.DB, eventId, endorserUser.id)
      }
    }
  }

  // Calculate tier
  const endorsers = await db.getEventEndorsers(c.env.DB, eventId)
  const attendeeCount = (await db.getEventAttendees(c.env.DB, eventId)).length
  const tier = calculateTier(endorsers, attendeeCount)
  await db.updateEvent(c.env.DB, eventId, { tier, people_attending: attendeeCount })

  // Notify members of the host center about the new event (EVENT_CREATED).
  fireNotify(
    c,
    (async () => {
      const recipientIds = await db.getBoardRecipientIds(c.env.DB, 'center', validCenterID)
      await push.dispatchNotification(
        c.env,
        recipientIds,
        notifications.NOTIFICATION_TYPES.EVENT_CREATED,
        `New event at ${center.name}`,
        validTitle ?? 'A new event was just posted.',
        {
          excludeUserId: user.id,
          actionUrl: `/events/${eventId}`,
          relatedEventId: eventId,
          relatedUserId: user.id,
        },
      )
    })(),
  )

  return c.json({ id: eventId, tier })
})

app.post('/removeEvent', authMiddleware, async (c) => {
  const user = c.get('user')
  const { id } = await c.req.json<{ id: string }>()
  if (!id) {
    return c.json({ message: 'Event ID required' }, 400)
  }

  const existing = await db.getEventById(c.env.DB, id)
  if (!existing) {
    return c.json({ message: 'Event not found' }, 404)
  }

  // Allow admin or the event creator to delete (mirrors /updateEvent gate;
  // legacy events with no creator are admin-only)
  const isCreator = existing.created_by === user.id
  if (!isAdmin(user) && !isCreator) {
    return c.json(
      { message: 'Insufficient permissions - only admin or event creator can delete' },
      401,
    )
  }

  // Capture attendees BEFORE deleting — the cascade wipes event_attendees.
  const attendeeIds = (await db.getBoardRecipientIds(c.env.DB, 'event', id)).filter(
    (uid) => uid !== user.id,
  )

  const result = await db.deleteEvent(c.env.DB, id)
  if (result.success) {
    if (attendeeIds.length > 0) {
      fireNotify(
        c,
        push.dispatchNotification(
          c.env,
          attendeeIds,
          notifications.NOTIFICATION_TYPES.EVENT_CANCELLED,
          `Event cancelled: ${existing.title}`,
          'An event you RSVP’d to has been cancelled.',
          { relatedUserId: user.id },
        ),
      )
    }
    return c.json({ message: 'Event removed' })
  }
  return c.json({ message: 'Failed to remove event' }, 500)
})

app.post('/fetchEvent', async (c) => {
  const { id } = await c.req.json<{ id: string }>()
  const event = await db.getEventById(c.env.DB, id)
  if (!event) {
    return c.json({ message: 'Event not found' }, 404)
  }
  return c.json({ message: 'Success', event: eventRowToApi(event) })
})

// GET alias of /fetchEvent (#125). See /fetchCenter alias above for the
// edge-cache rationale.
app.get('/fetchEvent', cacheControl(30), async (c) => {
  const id = c.req.query('id') ?? c.req.query('eventID')
  if (!id) return c.json({ message: 'Malformed id' }, 400)
  const event = await db.getEventById(c.env.DB, id)
  if (!event) {
    return c.json({ message: 'Event not found' }, 404)
  }
  return c.json({ message: 'Success', event: eventRowToApi(event) })
})

app.post('/updateEvent', authMiddleware, async (c) => {
  const user = c.get('user')

  const { eventJSON } = await c.req.json<{ eventJSON: any }>()

  const eventId = eventJSON.id || eventJSON.eventID
  if (!eventId) {
    return c.json({ message: 'Event ID required' }, 400)
  }

  const existing = await db.getEventById(c.env.DB, eventId)
  if (!existing) {
    return c.json({ message: 'Event not found' }, 404)
  }

  // Allow admin or the event creator to edit (or any logged-in user for events without creator)
  const userIsAdmin = isAdmin(user)
  const isCreator = existing.created_by === user.id
  const isEditable = userIsAdmin || isCreator || existing.created_by === null
  if (!isEditable) {
    return c.json({ message: 'Insufficient permissions - only admin or event creator can edit' }, 401)
  }

  const updates: Partial<EventRow> = {}
  if (eventJSON.title !== undefined) updates.title = eventJSON.title
  if (eventJSON.description !== undefined) updates.description = eventJSON.description
  if (eventJSON.date !== undefined) updates.date = eventJSON.date
  if (eventJSON.latitude !== undefined) updates.latitude = parseFloat(String(eventJSON.latitude))
  if (eventJSON.longitude !== undefined) updates.longitude = parseFloat(String(eventJSON.longitude))
  if (eventJSON.address !== undefined) updates.address = eventJSON.address
  if (eventJSON.centerID !== undefined) updates.center_id = eventJSON.centerID
  if (eventJSON.pointOfContact !== undefined) updates.point_of_contact = eventJSON.pointOfContact
  if (eventJSON.image !== undefined) updates.image = eventJSON.image
  if (eventJSON.category !== undefined) updates.category = eventJSON.category
  if (eventJSON.externalUrl !== undefined) updates.external_url = eventJSON.externalUrl
  if (eventJSON.signupUrl !== undefined) updates.signup_url = eventJSON.signupUrl
  if (eventJSON.allowJanataSignup !== undefined)
    updates.allow_janata_signup = eventJSON.allowJanataSignup ? 1 : 0

  const result = await db.updateEvent(c.env.DB, eventId, updates)
  if (result.success) {
    // Notify attendees that event details changed (EVENT_UPDATED). Only fire
    // when a guest-visible field actually changed (skip pure tier/count writes).
    const meaningful = ['title', 'description', 'date', 'address', 'center_id'].some(
      (k) => (updates as Record<string, unknown>)[k] !== undefined,
    )
    if (meaningful) {
      fireNotify(
        c,
        (async () => {
          const recipientIds = (
            await db.getBoardRecipientIds(c.env.DB, 'event', eventId)
          ).filter((uid) => uid !== user.id)
          await push.dispatchNotification(
            c.env,
            recipientIds,
            notifications.NOTIFICATION_TYPES.EVENT_UPDATED,
            `Event updated: ${updates.title ?? existing.title}`,
            'Details changed for an event you RSVP’d to.',
            {
              actionUrl: `/events/${eventId}`,
              relatedEventId: eventId,
              relatedUserId: user.id,
            },
          )
        })(),
      )
    }
    return c.json({ message: 'Event updated' })
  }
  return c.json({ message: 'Update failed' }, 400)
})

app.post('/getEventUsers', authMiddleware, async (c) => {
  const user = c.get('user')
  const { id } = await c.req.json<{ id: string }>()
  if (!id) {
    return c.json({ message: 'Bad request - missing id' }, 400)
  }

  const event = await db.getEventById(c.env.DB, id)
  if (!event) {
    return c.json({ message: 'Event not found' }, 404)
  }

  const attendees = await db.getEventAttendees(c.env.DB, id)
  // Gated: only an attendee, the event creator, or an admin may see WHO is going.
  // The public guest-inclusive COUNT lives on the event object instead.
  const isAttendee = attendees.some((a) => a.id === user.id)
  if (!isAttendee && event.created_by !== user.id && !isAdmin(user)) {
    return c.json({ message: 'Only attendees can view who is going' }, 403)
  }

  // Display-only fields, never PII. (Coordinators get emails + guests via the
  // gated GET /events/:id/roster.)
  return c.json({
    message: 'Success',
    users: attendees.map((u) => userRowToAttendee(u)),
  })
})

// Coordinator-only attendee roster. Unlike /getEventUsers (public, avatar-only
// display), this returns emails + account-less guest RSVPs and is gated to the
// event's creator or an admin — the "replaces the Google Form / spreadsheet"
// view that lives on the event page.
app.get('/events/:id/roster', authMiddleware, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  const event = await db.getEventById(c.env.DB, id)
  if (!event) {
    return c.json({ message: 'Event not found' }, 404)
  }

  const canManage = isAdmin(user) || (!!event.created_by && event.created_by === user.id)
  if (!canManage) {
    return c.json(
      { message: 'Only the event creator or an admin can view the attendee roster' },
      403,
    )
  }

  const { registered, guests } = await db.getEventRoster(c.env.DB, id)
  return c.json({
    registered: registered.map((r) => ({
      id: r.id,
      name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.username,
      email: r.email,
      image: r.profile_image,
      joinedAt: r.joined_at,
    })),
    guests: guests.map((g) => ({ name: g.name, email: g.email, rsvpedAt: g.rsvped_at })),
    counts: {
      registered: registered.length,
      guests: guests.length,
      total: registered.length + guests.length,
    },
  })
})

app.post('/attendEvent', authMiddleware, async (c) => {
  const user = c.get('user')
  const { eventID } = await c.req.json<{ eventID: string }>()

  if (!eventID) {
    return c.json({ message: 'eventID is required' }, 400)
  }

  const event = await db.getEventById(c.env.DB, eventID)
  if (!event) {
    return c.json({ message: 'Event not found' }, 404)
  }

  // #191 — per-event verified gate. UNVERIFIED_USER (30) signups can't RSVP
  // for events marked requires_verified. They get a 403 with a clear msg so
  // the UI can prompt them to verify their email first.
  if (event.requires_verified === 1 && (user.verification_level ?? 0) < NORMAL_USER) {
    return c.json(
      { message: 'This event requires a verified account. Please verify your email to RSVP.' },
      403,
    )
  }

  // Check if already registered
  const attendees = await db.getEventAttendees(c.env.DB, eventID)
  const alreadyRegistered = attendees.some((a) => a.id === user.id)
  if (alreadyRegistered) {
    return c.json({ message: 'Already registered for this event' }, 400)
  }

  const result = await db.addEventAttendee(c.env.DB, eventID, user.id)
  if (!result.success) {
    return c.json({ message: 'Failed to register attendance', error: result.error }, 500)
  }

  // Notify the event creator that someone joined (ATTENDEE_JOINED).
  if (event.created_by && event.created_by !== user.id) {
    fireNotify(
      c,
      push.dispatchNotification(
        c.env,
        [event.created_by],
        notifications.NOTIFICATION_TYPES.ATTENDEE_JOINED,
        `${displayName(user)} is attending ${event.title}`,
        `${displayName(user)} just RSVP’d to your event.`,
        {
          excludeUserId: user.id,
          actionUrl: `/events/${eventID}`,
          relatedEventId: eventID,
          relatedUserId: user.id,
        },
      ),
    )
  }

  const updated = await db.getEventById(c.env.DB, eventID)
  return c.json({
    message: 'Successfully registered for event',
    peopleAttending: updated?.people_attending ?? event.people_attending + 1,
  })
})

// #191 — public guest RSVP. No auth required. Rate-limited to discourage
// abuse. Rejects when the event has requires_verified = 1. The same email
// signing up + verifying later upgrades these into real attendee rows via
// db.upgradeGuestRsvpsForUser (wire-in pending — separate PR).
app.post('/attendEventGuest', rateLimit(5, 60_000), async (c) => {
  let body: { eventID?: string; email?: string; name?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ message: 'Invalid JSON body' }, 400)
  }
  const eventID = body.eventID
  const email = body.email?.trim().toLowerCase()
  const name = body.name?.trim()

  if (!eventID || typeof eventID !== 'string') {
    return c.json({ message: 'eventID is required' }, 400)
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ message: 'A valid email is required' }, 400)
  }
  if (!name || name.length < 1 || name.length > 120) {
    return c.json({ message: 'name is required (1–120 chars)' }, 400)
  }

  const event = await db.getEventById(c.env.DB, eventID)
  if (!event) return c.json({ message: 'Event not found' }, 404)
  if (event.requires_verified === 1) {
    return c.json(
      { message: 'This event requires a verified account. Please sign up and verify your email to RSVP.' },
      403,
    )
  }

  const result = await db.createGuestRsvp(c.env.DB, eventID, email, name)
  if (!result.success) {
    return c.json({ message: 'Failed to register RSVP', error: result.error }, 500)
  }

  return c.json({
    message: result.alreadyRsvped ? 'Already RSVPed' : 'RSVP recorded',
    alreadyRsvped: result.alreadyRsvped === true,
  })
})

app.post('/unattendEvent', authMiddleware, async (c) => {
  const user = c.get('user')
  const { eventID } = await c.req.json<{ eventID: string }>()

  if (!eventID) {
    return c.json({ message: 'eventID is required' }, 400)
  }

  const event = await db.getEventById(c.env.DB, eventID)
  if (!event) {
    return c.json({ message: 'Event not found' }, 404)
  }

  const result = await db.removeEventAttendee(c.env.DB, eventID, user.id)
  if (!result.success) {
    return c.json({ message: 'Failed to remove attendance', error: result.error }, 500)
  }

  const updated = await db.getEventById(c.env.DB, eventID)
  return c.json({
    message: 'Successfully unregistered from event',
    peopleAttending: updated?.people_attending ?? Math.max(0, event.people_attending - 1),
  })
})

app.post('/fetchEventsByCenter', async (c) => {
  const { centerID } = await c.req.json<{ centerID: string }>()
  const events = await db.getEventsByCenterId(c.env.DB, centerID)
  return c.json({
    message: 'Success',
    events: events.map(eventRowToApi),
  })
})

// GET alias of /fetchEventsByCenter (#125).
app.get('/fetchEventsByCenter', cacheControl(30), async (c) => {
  const centerID = c.req.query('centerID')
  if (!centerID) return c.json({ message: 'Malformed centerID' }, 400)
  const events = await db.getEventsByCenterId(c.env.DB, centerID)
  return c.json({
    message: 'Success',
    events: events.map(eventRowToApi),
  })
})

app.get('/fetchAllEvents', cacheControl(30), async (c) => {
  // Pagination (#107). Backwards-compatible: legacy callers omit `limit`
  // and get the full list. Paginated callers pass `?limit=&offset=` and
  // receive `{ events, total, limit, offset }` for infinite-scroll UIs.
  const limitParam = c.req.query('limit')
  if (limitParam == null) {
    const events = await db.getAllEvents(c.env.DB)
    return c.json({
      message: 'Success',
      events: events.map(eventRowToApi),
    })
  }
  const limit = Number.parseInt(limitParam, 10)
  const offset = Number.parseInt(c.req.query('offset') ?? '0', 10)
  if (!Number.isFinite(limit) || limit < 1) {
    return c.json({ message: 'limit must be a positive integer' }, 400)
  }
  if (!Number.isFinite(offset) || offset < 0) {
    return c.json({ message: 'offset must be >= 0' }, 400)
  }
  const { data, total } = await db.getEventsPaginated(c.env.DB, limit, offset)
  return c.json({
    message: 'Success',
    events: data.map(eventRowToApi),
    total,
    limit: Math.min(limit, 200),
    offset,
  })
})

// ══════════════════════════════════════════════════════════════════════
// PROFILE IMAGE ROUTES
// ══════════════════════════════════════════════════════════════════════

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic']
const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB
app.post('/profile/uploadImage', authMiddleware, async (c) => {
  const user = c.get('user')

  // Parse multipart form data
  const body = await c.req.parseBody()
  const file = body['file']

  // Validate file
  if (!(file instanceof File)) {
    return c.json({ message: 'No file uploaded' }, 400)
  }

  // Validate file type
  if (!ALLOWED_TYPES.includes(file.type)) {
    return c.json(
      { message: 'Unsupported file type. Allowed types are JPEG, PNG, GIF, WebP, HEIC' },
      400
    )
  }

  // Validate file size (max 5MB)
  if (file.size > MAX_FILE_SIZE) {
    return c.json({ message: 'File size exceeds 5MB limit' }, 400)
  }

  // Generate unique filename
  const ext = file.name.split('.').pop() || 'jpg'
  const key = `avatars/${user.id}/${crypto.randomUUID()}.${ext}`

  // Upload to R2
  await c.env.AVATARS.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: {
      userId: user.id,
      originalFileName: file.name,
    },
  })

  // R2 custom domain is bound at the bucket root → public URL is domain + key
  // (key already includes the avatars/ folder). No extra "/avatars" segment.
  const baseUrl = 'https://avatars.chinmayajanata.org'
  const url = `${baseUrl}/${key}`

  // Update user profile with new image URL
  await db.updateUser(c.env.DB, user.id, {
    profile_image: url,
  })

  return c.json({ message: 'Profile image uploaded successfully', imageUrl: url })
})

// Board image upload (#283). Mirrors /profile/uploadImage but stores under a
// `boards/` prefix and does NOT touch the user's profile — it just returns a
// URL the client passes to createBoardPost as `imageUrl`.
app.post('/board/uploadImage', authMiddleware, async (c) => {
  const user = c.get('user')

  const body = await c.req.parseBody()
  const file = body['file']

  if (!(file instanceof File)) {
    return c.json({ message: 'No file uploaded' }, 400)
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    return c.json(
      { message: 'Unsupported file type. Allowed types are JPEG, PNG, GIF, WebP, HEIC' },
      400
    )
  }
  if (file.size > MAX_FILE_SIZE) {
    return c.json({ message: 'File size exceeds 5MB limit' }, 400)
  }

  const ext = file.name.split('.').pop() || 'jpg'
  const key = `boards/${user.id}/${crypto.randomUUID()}.${ext}`

  await c.env.AVATARS.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: { userId: user.id, originalFileName: file.name },
  })

  // The R2 custom domain is bound at the bucket root, so the public URL is
  // domain + object key (the key already namespaces under boards/). A previous
  // extra "/avatars" segment 404'd — board photos showed as a grey box.
  const url = `https://avatars.chinmayajanata.org/${key}`
  return c.json({ message: 'Image uploaded', imageUrl: url })
})

// ── Fun route ─────────────────────────────────────────────────────────

app.post('/brewCoffee', (c) => {
  return c.json(
    {
      message:
        'This server is a teapot, and cannot brew coffee. It not just cannot, but it will not. How dare you disgrace this server with a request to brew coffee? This is a server that brews tea. Masala Chai >>> Filter Coffee.',
    },
    418
  )
})

// ── Tier calculation ──────────────────────────────────────────────────

function calculateTier(endorsers: UserRow[], attendeeCount: number): number {
  let tier = 0
  let brahmachariAndAbove = 0

  for (const endorser of endorsers) {
    tier += endorser.points * endorser.verification_level
    if (endorser.verification_level >= BRAHMACHARI) {
      brahmachariAndAbove++
    }
  }

  tier += attendeeCount * NORMAL_USER
  tier *= brahmachariAndAbove + 1
  tier = Math.floor(tier / TIER_DESCALE)

  return tier
}

// ═══════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════

app.get('/admin/stats', adminMiddleware, async (c) => {
  const [users, centers, events] = await Promise.all([
    db.countUsers(c.env.DB),
    db.countCenters(c.env.DB),
    db.countEvents(c.env.DB),
  ])
  return c.json({ users, centers, events })
})

app.get('/admin/users', adminMiddleware, async (c) => {
  const url = new URL(c.req.url)
  const q = url.searchParams.get('q') || undefined
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 100)
  const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0)
  const { data, total } = await db.listUsers(c.env.DB, { q, limit, offset })
  return c.json({ data: data.map(userRowToApi), total, limit, offset })
})

app.get('/admin/centers', adminMiddleware, async (c) => {
  const url = new URL(c.req.url)
  const q = url.searchParams.get('q') || undefined
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 100)
  const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0)
  const { data, total } = await db.listCenters(c.env.DB, { q, limit, offset })
  return c.json({ data: data.map(centerRowToApi), total, limit, offset })
})

app.get('/admin/events', adminMiddleware, async (c) => {
  const url = new URL(c.req.url)
  const q = url.searchParams.get('q') || undefined
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 100)
  const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0)
  const { data, total } = await db.listEvents(c.env.DB, { q, limit, offset })
  return c.json({ data: data.map(eventRowToApi), total, limit, offset })
})

// ── Admin center actions ──────────────────────────────────────────────

app.put('/admin/centers/:id', adminMiddleware, async (c) => {
  const centerId = c.req.param('id')
  const center = await db.getCenterById(c.env.DB, centerId)
  if (!center) {
    return c.json({ message: 'Center not found' }, 404)
  }

  const body = await c.req.json<{
    name?: string
    address?: string
    website?: string
    phone?: string
    image?: string
    acharya?: string
    pointOfContact?: string
    description?: string
  }>()

  const updates: Partial<CenterRow> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.address !== undefined) updates.address = body.address
  if (body.website !== undefined) updates.website = body.website
  if (body.phone !== undefined) updates.phone = body.phone
  if (body.image !== undefined) updates.image = body.image
  if (body.acharya !== undefined) updates.acharya = body.acharya
  if (body.pointOfContact !== undefined) updates.point_of_contact = body.pointOfContact
  if (body.description !== undefined) updates.description = body.description

  const result = await db.updateCenter(c.env.DB, centerId, updates)
  if (result.success) {
    return c.json({ message: 'Center updated' })
  }
  return c.json({ message: 'Failed to update center', error: result.error }, 500)
})

app.post('/admin/centers/:id/verify', adminMiddleware, async (c) => {
  const centerId = c.req.param('id')
  const center = await db.getCenterById(c.env.DB, centerId)
  if (!center) {
    return c.json({ message: 'Center not found' }, 404)
  }

  const newValue = center.is_verified ? 0 : 1
  const result = await db.updateCenter(c.env.DB, centerId, { is_verified: newValue })
  if (result.success) {
    return c.json({ message: newValue ? 'Center verified' : 'Center unverified' })
  }
  return c.json({ message: 'Failed to toggle verification', error: result.error }, 500)
})

app.delete('/admin/centers/:id', adminMiddleware, async (c) => {
  const centerId = c.req.param('id')
  const center = await db.getCenterById(c.env.DB, centerId)
  if (!center) {
    return c.json({ message: 'Center not found' }, 404)
  }

  const result = await db.deleteCenter(c.env.DB, centerId)
  if (result.success) {
    return c.json({ message: 'Center deleted' })
  }
  return c.json({ message: 'Failed to delete center', error: result.error }, 500)
})

app.get('/admin/centers/:id/members', adminMiddleware, async (c) => {
  const centerId = c.req.param('id')
  const center = await db.getCenterById(c.env.DB, centerId)
  if (!center) {
    return c.json({ message: 'Center not found' }, 404)
  }

  const members = await db.getCenterMembers(c.env.DB, centerId)
  return c.json({ data: members.map(userRowToApi) })
})

// ── Admin event actions ───────────────────────────────────────────────

app.put('/admin/events/:id', adminMiddleware, async (c) => {
  const eventId = c.req.param('id')
  const event = await db.getEventById(c.env.DB, eventId)
  if (!event) {
    return c.json({ message: 'Event not found' }, 404)
  }

  const body = await c.req.json<{
    title?: string
    description?: string
    date?: string
    address?: string
    pointOfContact?: string
    image?: string
    category?: number
    externalUrl?: string | null
    signupUrl?: string | null
    allowJanataSignup?: boolean
  }>()

  const updates: Partial<EventRow> = {}
  if (body.title !== undefined) updates.title = body.title
  if (body.description !== undefined) updates.description = body.description
  if (body.date !== undefined) updates.date = body.date
  if (body.address !== undefined) updates.address = body.address
  if (body.pointOfContact !== undefined) updates.point_of_contact = body.pointOfContact
  if (body.image !== undefined) updates.image = body.image
  if (body.category !== undefined) updates.category = body.category
  if (body.externalUrl !== undefined) updates.external_url = body.externalUrl
  if (body.signupUrl !== undefined) updates.signup_url = body.signupUrl
  if (body.allowJanataSignup !== undefined) updates.allow_janata_signup = body.allowJanataSignup ? 1 : 0

  const result = await db.updateEvent(c.env.DB, eventId, updates)
  if (result.success) {
    return c.json({ message: 'Event updated' })
  }
  return c.json({ message: 'Failed to update event', error: result.error }, 500)
})

app.delete('/admin/events/:id', adminMiddleware, async (c) => {
  const eventId = c.req.param('id')
  const event = await db.getEventById(c.env.DB, eventId)
  if (!event) {
    return c.json({ message: 'Event not found' }, 404)
  }

  const result = await db.deleteEvent(c.env.DB, eventId)
  if (result.success) {
    return c.json({ message: 'Event deleted' })
  }
  return c.json({ message: 'Failed to delete event', error: result.error }, 500)
})

// ── Admin user actions ──────────────────────────────────────────────

app.post('/admin/users/:id/verify', adminMiddleware, async (c) => {
  const userId = c.req.param('id')
  const targetUser = await db.getUserById(c.env.DB, userId)
  if (!targetUser) {
    return c.json({ message: 'User not found' }, 404)
  }

  const body = await c.req.json<{
    verificationLevel?: number
    isVerified?: boolean
  }>()

  const updates: Partial<UserRow> = {}

  if (body.isVerified === false) {
    updates.is_verified = 0
    updates.verification_level = body.verificationLevel ?? NORMAL_USER
  } else {
    updates.is_verified = 1
    updates.verification_level = body.verificationLevel ?? targetUser.verification_level
  }

  const result = await db.updateUser(c.env.DB, userId, updates)
  if (result.success) {
    return c.json({
      message: updates.is_verified ? 'User verified' : 'User unverified',
      isVerified: updates.is_verified === 1,
    })
  }
  return c.json({ message: 'Update failed' }, 500)
})

app.delete('/admin/users/:id', adminMiddleware, async (c) => {
  const userId = c.req.param('id')
  const adminUser = c.get('user')

  if (adminUser.id === userId) {
    return c.json({ message: 'Cannot delete your own account from admin panel' }, 400)
  }

  const targetUser = await db.getUserById(c.env.DB, userId)
  if (!targetUser) {
    return c.json({ message: 'User not found' }, 404)
  }

  const result = await db.deleteUser(c.env.DB, userId)
  if (result.success) {
    return c.json({ message: 'User deleted' })
  }
  return c.json({ message: 'Delete failed' }, 500)
})

// ── Admin invite code actions ──────────────────────────────────────────

app.get('/admin/invite-codes', adminMiddleware, async (c) => {
  const codes = await inviteCodes.getAllInviteCodes(c.env)
  const codesWithUsage = await Promise.all(
    codes.map(async (code) => ({
      ...inviteCodes.inviteCodeRowToApi(code),
      usageCount: await inviteCodes.countUsersWithCode(c.env, code.code),
    }))
  )
  return c.json({ data: codesWithUsage })
})

app.post('/admin/invite-codes', adminMiddleware, async (c) => {
  const body = await c.req.json<{
    code: string
    label: string
    verificationLevel?: number
  }>()

  if (!body.code || !body.label) {
    return c.json({ message: 'Code and label are required' }, 400)
  }

  const verificationLevel = body.verificationLevel ?? NORMAL_USER
  if (verificationLevel >= ADMIN_CUTOFF) {
    return c.json({ message: 'Verification level cannot grant admin access' }, 400)
  }

  const result = await inviteCodes.createInviteCode(
    c.env,
    body.code,
    body.label,
    verificationLevel,
    true
  )

  if (result.success) {
    return c.json({ message: 'Invite code created' })
  }
  return c.json({ message: result.error || 'Failed to create invite code' }, 400)
})

app.post('/admin/invite-codes/:code/toggle', adminMiddleware, async (c) => {
  const code = c.req.param('code')
  const existing = await inviteCodes.getInviteCode(c.env, code)
  if (!existing) {
    return c.json({ message: 'Invite code not found' }, 404)
  }

  const result = existing.is_active
    ? await inviteCodes.deactivateInviteCode(c.env, code)
    : await inviteCodes.reactivateInviteCode(c.env, code)

  if (result.success) {
    return c.json({ message: existing.is_active ? 'Code deactivated' : 'Code activated' })
  }
  return c.json({ message: result.error || 'Failed to toggle invite code' }, 500)
})

app.get('/admin/invite-codes/:code/users', adminMiddleware, async (c) => {
  const code = c.req.param('code')
  const userIds = await inviteCodes.getUsersWithCode(c.env, code)
  const users = await Promise.all(
    userIds.map(async (id) => {
      const user = await db.getUserById(c.env.DB, id)
      return user ? userRowToApi(user) : null
    })
  )
  return c.json({ data: users.filter(Boolean) })
})

// ═══════════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /notifications
 * Get all notifications for the authenticated user
 */
app.get('/notifications', authMiddleware, async (c) => {
  const user = c.get('user')
  const limit = parseInt(c.req.query('limit') || '50')
  const offset = parseInt(c.req.query('offset') || '0')
  const unreadOnly = c.req.query('unreadOnly') === 'true'

  const notifs = await notifications.getUserNotifications(c.env, user.id, {
    limit: Math.min(limit, 100),
    offset,
    unreadOnly,
  })

  return c.json({
    notifications: notifs.map(notifications.notificationRowToApi),
    count: notifs.length,
  })
})

/**
 * GET /notifications/unread-count
 * Get unread notification count for the authenticated user
 */
app.get('/notifications/unread-count', authMiddleware, async (c) => {
  const user = c.get('user')
  const count = await notifications.getUnreadNotificationCount(c.env, user.id)
  return c.json({ unreadCount: count })
})

/**
 * PUT /notifications/:id/read
 * Mark a notification as read
 */
app.put('/notifications/:id/read', authMiddleware, async (c) => {
  const user = c.get('user')
  const notifId = c.req.param('id')

  const success = await notifications.markNotificationAsRead(c.env, notifId, user.id)

  if (success) {
    return c.json({ message: 'Notification marked as read' })
  }

  return c.json({ message: 'Notification not found' }, 404)
})

/**
 * PUT /notifications/mark-all-read
 * Mark all notifications as read
 */
app.put('/notifications/mark-all-read', authMiddleware, async (c) => {
  const user = c.get('user')

  await notifications.markAllNotificationsAsRead(c.env, user.id)

  return c.json({ message: 'All notifications marked as read' })
})

/**
 * PUT /notifications/:id/archive
 * Archive a notification
 */
app.put('/notifications/:id/archive', authMiddleware, async (c) => {
  const user = c.get('user')
  const notifId = c.req.param('id')

  const success = await notifications.archiveNotification(c.env, notifId, user.id)

  if (success) {
    return c.json({ message: 'Notification archived' })
  }

  return c.json({ message: 'Notification not found' }, 404)
})

/**
 * DELETE /notifications/:id
 * Delete a notification
 */
app.delete('/notifications/:id', authMiddleware, async (c) => {
  const user = c.get('user')
  const notifId = c.req.param('id')

  const success = await notifications.deleteNotification(c.env, notifId, user.id)

  if (success) {
    return c.json({ message: 'Notification deleted' })
  }

  return c.json({ message: 'Notification not found' }, 404)
})

/**
 * GET /notifications/preferences
 * Get notification preferences for the authenticated user
 */
app.get('/notifications/preferences', authMiddleware, async (c) => {
  const user = c.get('user')

  let prefs = await notifications.getNotificationPreferences(c.env, user.id)

  // Create default preferences if they don't exist
  if (!prefs) {
    prefs = await notifications.createDefaultNotificationPreferences(c.env, user.id)
  }

  return c.json(notifications.preferencesRowToApi(prefs))
})

/**
 * PUT /notifications/preferences
 * Update notification preferences
 */
app.put('/notifications/preferences', authMiddleware, async (c) => {
  const user = c.get('user')

  // Body validation (#127). Reject malformed JSON, non-object bodies, and
  // wrong types on known fields. Unknown keys are silently dropped — no need
  // to 400 over forward-compatible extras.
  let body: Record<string, unknown>
  try {
    const parsed = await c.req.json()
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return c.json({ message: 'Body must be a JSON object' }, 400)
    }
    body = parsed as Record<string, unknown>
  } catch {
    return c.json({ message: 'Invalid JSON body' }, 400)
  }

  const BOOL_KEYS = [
    'inAppEnabled', 'pushEnabled', 'emailEnabled',
    'eventReminders', 'eventCreated', 'eventCancelled', 'eventUpdated',
    'attendeeJoined', 'centerAnnouncements',
    'boardPosts', 'boardReplies', 'boardReactions', 'boardMentions',
    'quietHoursEnabled',
  ] as const
  for (const k of BOOL_KEYS) {
    if (body[k] !== undefined && typeof body[k] !== 'boolean') {
      return c.json({ message: `${k} must be a boolean` }, 400)
    }
  }
  const STRING_KEYS = ['quietHoursStart', 'quietHoursEnd'] as const
  for (const k of STRING_KEYS) {
    if (body[k] !== undefined && body[k] !== null && typeof body[k] !== 'string') {
      return c.json({ message: `${k} must be a string or null` }, 400)
    }
  }

  // Convert from camelCase API format to snake_case DB format
  const updates: Partial<notifications.NotificationPreferenceRow> = {}

  if (body.inAppEnabled !== undefined) updates.in_app_enabled = body.inAppEnabled ? 1 : 0
  if (body.pushEnabled !== undefined) updates.push_enabled = body.pushEnabled ? 1 : 0
  if (body.emailEnabled !== undefined) updates.email_enabled = body.emailEnabled ? 1 : 0
  if (body.eventReminders !== undefined) updates.event_reminders = body.eventReminders ? 1 : 0
  if (body.eventCreated !== undefined) updates.event_created = body.eventCreated ? 1 : 0
  if (body.eventCancelled !== undefined) updates.event_cancelled = body.eventCancelled ? 1 : 0
  if (body.eventUpdated !== undefined) updates.event_updated = body.eventUpdated ? 1 : 0
  if (body.attendeeJoined !== undefined) updates.attendee_joined = body.attendeeJoined ? 1 : 0
  if (body.centerAnnouncements !== undefined) updates.center_announcements = body.centerAnnouncements ? 1 : 0
  if (body.boardPosts !== undefined) updates.board_posts = body.boardPosts ? 1 : 0
  if (body.boardReplies !== undefined) updates.board_replies = body.boardReplies ? 1 : 0
  if (body.boardReactions !== undefined) updates.board_reactions = body.boardReactions ? 1 : 0
  if (body.boardMentions !== undefined) updates.board_mentions = body.boardMentions ? 1 : 0
  if (body.quietHoursStart !== undefined) updates.quiet_hours_start = body.quietHoursStart as string | null
  if (body.quietHoursEnd !== undefined) updates.quiet_hours_end = body.quietHoursEnd as string | null
  if (body.quietHoursEnabled !== undefined) updates.quiet_hours_enabled = body.quietHoursEnabled ? 1 : 0

  const prefs = await notifications.updateNotificationPreferences(c.env, user.id, updates)

  if (!prefs) {
    return c.json({ message: 'Preferences not found' }, 404)
  }

  return c.json(notifications.preferencesRowToApi(prefs))
})

// ═══════════════════════════════════════════════════════════════════════
// PUSH TOKENS (#102)
// ═══════════════════════════════════════════════════════════════════════

/**
 * POST /push/register
 * Register (or refresh) this device's Expo push token. Called after the app
 * obtains permission and a token. Idempotent — re-registering updates the row.
 */
app.post('/push/register', authMiddleware, async (c) => {
  const user = c.get('user')
  const body: { token?: string; platform?: string; deviceId?: string } = await c.req
    .json()
    .catch(() => ({}))

  if (!push.isExpoPushToken(body.token)) {
    return c.json({ message: 'A valid Expo push token is required' }, 400)
  }

  await push.registerPushToken(c.env, user.id, body.token, body.platform, body.deviceId)
  return c.json({ ok: true })
})

/**
 * POST /push/unregister
 * Remove a device token (logout / disable push). Idempotent.
 */
app.post('/push/unregister', authMiddleware, async (c) => {
  const body: { token?: string } = await c.req.json().catch(() => ({}))
  if (!body.token || typeof body.token !== 'string') {
    return c.json({ message: 'token is required' }, 400)
  }
  await push.removePushToken(c.env, body.token)
  return c.json({ ok: true })
})

// ═══════════════════════════════════════════════════════════════════════
// ADMIN NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /admin/notifications
 * List all notifications across all users (paginated, searchable)
 */
app.get('/admin/notifications', adminMiddleware, async (c) => {
  const url = new URL(c.req.url)
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 100)
  const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0)
  const userId = url.searchParams.get('userId') || undefined
  const typeId = url.searchParams.get('typeId') ? parseInt(url.searchParams.get('typeId')!, 10) : undefined

  let query = `SELECT n.*, u.first_name, u.last_name, u.username FROM notifications n LEFT JOIN users u ON n.user_id = u.id`
  const conditions: string[] = []
  const values: any[] = []

  if (userId) {
    conditions.push('n.user_id = ?')
    values.push(userId)
  }
  if (typeId) {
    conditions.push('n.type_id = ?')
    values.push(typeId)
  }

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(' AND ')}`
  }

  query += ` ORDER BY n.created_at DESC LIMIT ? OFFSET ?`
  values.push(limit, offset)

  const stmt = c.env.DB.prepare(query)
  const result = await stmt.bind(...values).all()

  // Get total count
  let countQuery = `SELECT COUNT(*) as count FROM notifications n`
  const countValues = values.slice(0, -2) // exclude limit/offset
  if (conditions.length > 0) {
    countQuery += ` WHERE ${conditions.join(' AND ')}`
  }
  const countResult = await c.env.DB.prepare(countQuery).bind(...countValues).first<{ count: number }>()

  return c.json({
    data: (result.results || []).map((row: any) => ({
      ...notifications.notificationRowToApi(row),
      recipientName: row.first_name && row.last_name ? `${row.first_name} ${row.last_name}` : row.username || 'Unknown',
      recipientUsername: row.username,
    })),
    total: countResult?.count || 0,
    limit,
    offset,
  })
})

/**
 * GET /admin/notifications/stats
 * Notification system stats for admin dashboard
 */
app.get('/admin/notifications/stats', adminMiddleware, async (c) => {
  const [totalResult, unreadResult, typeBreakdown, recentResult] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) as count FROM notifications').first<{ count: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM notifications WHERE is_read = 0').first<{ count: number }>(),
    c.env.DB.prepare('SELECT type_id, COUNT(*) as count FROM notifications GROUP BY type_id').all(),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM notifications WHERE created_at > datetime("now", "-24 hours")').first<{ count: number }>(),
  ])

  return c.json({
    total: totalResult?.count || 0,
    unread: unreadResult?.count || 0,
    last24h: recentResult?.count || 0,
    byType: (typeBreakdown.results || []).map((row: any) => ({
      typeId: row.type_id,
      count: row.count,
    })),
  })
})

/**
 * POST /admin/notifications/send
 * Send a notification to a user or all users
 */
app.post('/admin/notifications/send', adminMiddleware, async (c) => {
  const body = await c.req.json<{
    userId?: string
    typeId: number
    title: string
    message: string
    actionUrl?: string
    broadcast?: boolean
  }>()

  if (!body.title || !body.message || !body.typeId) {
    return c.json({ message: 'title, message, and typeId are required' }, 400)
  }

  if (body.broadcast) {
    // Broadcast to all users via batch insert. The old code looped
    // sequentially calling createNotification per user — that hits the
    // Workers CPU time limit (30s sustained) once the user table grows.
    // Batch insert sends one round trip per chunk and reuses the prepared
    // statement, taking us from O(N round-trips) to O(N/chunk).
    const users = await c.env.DB.prepare('SELECT id FROM users').all<{ id: string }>()
    const userIds = (users.results || []).map((u) => u.id)
    let sent = 0
    if (userIds.length > 0) {
      const now = new Date().toISOString()
      const stmt = c.env.DB.prepare(
        `INSERT INTO notifications
          (id, user_id, type_id, title, message, action_url, is_read, is_archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
      )
      // Chunk into batches of 50 — D1's batch size limit is 100ish in
      // practice; 50 leaves headroom and bounds round-trip latency.
      const CHUNK = 50
      for (let i = 0; i < userIds.length; i += CHUNK) {
        const slice = userIds.slice(i, i + CHUNK)
        const statements = slice.map((uid) =>
          stmt.bind(
            crypto.randomUUID(),
            uid,
            body.typeId,
            body.title,
            body.message,
            body.actionUrl ?? null,
            now,
            now,
          ),
        )
        const results = await c.env.DB.batch(statements)
        sent += results.reduce((acc, r) => acc + (r.success ? 1 : 0), 0)
      }
    }
    return c.json({ message: `Notification sent to ${sent} users`, sent })
  }

  if (!body.userId) {
    return c.json({ message: 'userId is required when not broadcasting' }, 400)
  }

  const notif = await notifications.createNotification(c.env, body.userId, body.typeId, body.title, body.message, {
    actionUrl: body.actionUrl,
  })

  return c.json({ message: 'Notification sent', notification: notifications.notificationRowToApi(notif) })
})

/**
 * DELETE /admin/notifications/:id
 * Admin delete any notification
 */
app.delete('/admin/notifications/:id', adminMiddleware, async (c) => {
  const notifId = c.req.param('id')

  const result = await c.env.DB.prepare('DELETE FROM notifications WHERE id = ?').bind(notifId).run()

  // Distinguish "didn't exist" (404) from a DB failure (500). `result.success`
  // is true even on 0-row deletes, so use meta.changes for the 404 path (#127).
  if (!result.success) {
    return c.json({ message: 'Failed to delete notification' }, 500)
  }
  if ((result.meta?.changes ?? 0) === 0) {
    return c.json({ message: 'Notification not found' }, 404)
  }
  return c.json({ message: 'Notification deleted' })
})

// ═══════════════════════════════════════════════════════════════════════
// MODERATION — ADMIN (#209)
// ═══════════════════════════════════════════════════════════════════════

/** Admin moderation queue: reported posts grouped by post, newest first. */
app.get('/admin/moderation/queue', moderatorMiddleware, async (c) => {
  const moderator = c.get('user')
  const url = new URL(c.req.url)
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 100)
  const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0)
  const includeResolved = url.searchParams.get('includeResolved') === 'true'

  const { items, total } = await db.listModerationQueue(c.env.DB, {
    limit,
    offset,
    includeResolved,
    scope: moderationScopeFor(moderator),
  })
  return c.json({
    data: items.map((item) => ({
      post: boardPostToApi(item.post),
      reportCount: item.reportCount,
      openReportCount: item.openReportCount,
      latestReportAt: item.latestReportAt,
      latestReason: item.latestReason,
      status: item.status,
    })),
    total,
    limit,
    offset,
  })
})

/** Admin: soft-delete a reported post and resolve its open reports. */
app.post('/admin/moderation/posts/:postId/delete', moderatorMiddleware, async (c) => {
  const admin = c.get('user')
  const postId = c.req.param('postId')

  const existing = await db.getBoardPostByIdIncludingDeleted(c.env.DB, postId)
  if (!existing) {
    return c.json({ message: 'Board post not found' }, 404)
  }

  const scope = moderationScopeFor(admin)
  const canModerate = await db.canModerateBoardPost(c.env.DB, postId, scope)
  if (!canModerate) {
    return c.json({ message: 'You do not have access to moderate this post' }, 403)
  }

  const userIsAdmin = isAdmin(admin)
  const result = await db.softDeleteBoardPost(c.env.DB, postId, {
    id: admin.id,
    isAdmin: userIsAdmin,
    canModerate: !userIsAdmin,
  })
  // already_deleted is fine — the post is gone either way; we still resolve
  // reports and log the action so the queue clears.
  if (!result.ok && result.reason === 'not_found') {
    return c.json({ message: 'Board post not found' }, 404)
  }

  await db.markReportsActionedForPost(c.env.DB, postId)
  await db.createModerationAction(c.env.DB, {
    id: crypto.randomUUID(),
    actorId: admin.id,
    action: 'delete_post',
    targetPostId: postId,
    targetUserId: existing.author_id,
    metadata: { alreadyDeleted: !result.ok },
  })
  return c.json({ message: 'Post removed', alreadyDeleted: !result.ok })
})

/** Admin: suspend a user's posting privileges (timed or indefinite). */
app.post('/admin/moderation/users/:userId/suspend', adminMiddleware, async (c) => {
  const admin = c.get('user')
  const userId = c.req.param('userId')

  const body = await c.req
    .json<{ reason?: string; until?: string | null; durationDays?: number }>()
    .catch(() => ({}) as { reason?: string; until?: string | null; durationDays?: number })

  const target = await db.getUserById(c.env.DB, userId)
  if (!target) {
    return c.json({ message: 'User not found' }, 404)
  }
  if (target.id === admin.id) {
    return c.json({ message: 'You cannot suspend yourself' }, 400)
  }
  if (isAdmin(target)) {
    return c.json({ message: 'Cannot suspend an admin' }, 403)
  }

  // Resolve the suspension end. durationDays wins; else an explicit ISO
  // `until`; else null = indefinite.
  let until: string | null = null
  if (body.durationDays !== undefined) {
    if (!Number.isFinite(body.durationDays) || body.durationDays <= 0) {
      return c.json({ message: 'durationDays must be a positive number' }, 400)
    }
    until = new Date(Date.now() + body.durationDays * 24 * 60 * 60 * 1000).toISOString()
  } else if (body.until) {
    const parsed = new Date(body.until)
    if (Number.isNaN(parsed.getTime())) {
      return c.json({ message: 'until must be a valid ISO date' }, 400)
    }
    until = parsed.toISOString()
  }

  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null
  const ok = await db.suspendUser(c.env.DB, { userId, until, reason, by: admin.id })
  if (!ok) {
    return c.json({ message: 'Failed to suspend user' }, 500)
  }
  await db.createModerationAction(c.env.DB, {
    id: crypto.randomUUID(),
    actorId: admin.id,
    action: 'suspend_user',
    targetUserId: userId,
    reason,
    metadata: { until },
  })
  const updated = await db.getUserById(c.env.DB, userId)
  return c.json({ message: 'User suspended', user: updated ? userRowToApi(updated) : null })
})

/** Admin: lift a user's suspension. */
app.post('/admin/moderation/users/:userId/unsuspend', adminMiddleware, async (c) => {
  const admin = c.get('user')
  const userId = c.req.param('userId')

  const target = await db.getUserById(c.env.DB, userId)
  if (!target) {
    return c.json({ message: 'User not found' }, 404)
  }

  const ok = await db.unsuspendUser(c.env.DB, userId)
  if (!ok) {
    return c.json({ message: 'Failed to lift suspension' }, 500)
  }
  await db.createModerationAction(c.env.DB, {
    id: crypto.randomUUID(),
    actorId: admin.id,
    action: 'unsuspend_user',
    targetUserId: userId,
  })
  const updated = await db.getUserById(c.env.DB, userId)
  return c.json({ message: 'Suspension lifted', user: updated ? userRowToApi(updated) : null })
})

/** Admin: moderation audit log, newest first. */
app.get('/admin/moderation/audit', moderatorMiddleware, async (c) => {
  const moderator = c.get('user')
  const url = new URL(c.req.url)
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 100)
  const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0)
  const { items, total } = await db.listModerationActions(c.env.DB, {
    limit,
    offset,
    scope: moderationScopeFor(moderator),
  })
  return c.json({ data: items.map(moderationActionRowToApi), total, limit, offset })
})

// ── Default export ────────────────────────────────────────────────────

export default app

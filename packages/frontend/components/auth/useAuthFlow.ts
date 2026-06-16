import { useState, useEffect, useCallback } from 'react'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { useUser } from '../contexts'
import { useAnalytics } from '../../utils/analytics'
import { validateEmail, validatePassword } from '../../utils'
import { extractInviteCode } from '../../utils/validation'
import { inviteClient } from '../../src/auth/inviteClient'

export type AuthStep = 'initial' | 'login' | 'signup'

/**
 * useAuthFlow — the auth state machine shared by auth.tsx (native) and
 * auth.web.tsx (web). The two screens are platform-split for presentation only
 * (RN views vs HTML); this hook holds the logic so it lives in ONE place. Edits
 * to behavior (invite intent, email collision, grandfather upgrade) happen here,
 * not twice. Each screen wires the returned state/handlers into its own markup.
 */
export function useAuthFlow() {
  const router = useRouter()
  const { checkUserExists, login, signup, loading, getToken } = useUser()
  const { track } = useAnalytics()

  const params = useLocalSearchParams<{
    mode?: string
    returnTo?: string
    inviteCode?: string
    email?: string
    inviter?: string
    gated?: string
  }>()
  const urlInviteCode = typeof params.inviteCode === 'string' ? params.inviteCode : ''
  const urlEmail = typeof params.email === 'string' ? params.email : ''
  const returnTo = typeof params.returnTo === 'string' ? params.returnTo : null
  const isInviteWallEntry = params.gated === '1'
  // Door 1 carries the resolved inviter name forward, so the applied bar shows
  // the vouch without a second lookup. Absent → nameless.
  const inviterName = typeof params.inviter === 'string' && params.inviter ? params.inviter : null

  // mode=login needs a prefilled email. Invite links still start email-first so
  // a new member only sees password fields after we know the email is new.
  const initialStep = (): AuthStep =>
    params.mode === 'login' && urlEmail
      ? 'login'
      : 'initial'

  const [authStep, setAuthStep] = useState<AuthStep>(initialStep)
  const [username, setUsername] = useState(urlEmail)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [inviteCode, setInviteCode] = useState(urlInviteCode || '')
  const [errors, setErrors] = useState<{ [key: string]: string }>({})
  // collisionFlip = a signup whose email already exists bounced into login,
  // holding the invite to apply on the way in (new-22).
  const [collisionFlip, setCollisionFlip] = useState(false)

  const emailEditable = authStep === 'initial' || (authStep === 'signup' && !urlEmail)
  const hasInvite = !!extractInviteCode(inviteCode)

  // Re-sync when the URL params change (e.g. AuthPromptModal deep links).
  useEffect(() => {
    setAuthStep(initialStep())
    setUsername(urlEmail)
    setInviteCode(urlInviteCode || '')
    setPassword('')
    setConfirmPassword('')
    setCollisionFlip(false)
    setErrors({})
    // initialStep is derived from these same params; listing the inputs is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.mode, urlEmail, urlInviteCode])

  const changeUsername = useCallback((text: string) => {
    setUsername(text)
    setErrors((prev) => ({ ...prev, username: '' }))
  }, [])
  const changePassword = useCallback((text: string) => {
    setPassword(text)
    setErrors((prev) => ({ ...prev, password: '' }))
  }, [])
  const changeConfirm = useCallback((text: string) => {
    setConfirmPassword(text)
    setErrors((prev) => ({ ...prev, confirmPassword: '' }))
  }, [])

  const handleContinue = useCallback(async () => {
    setErrors({})
    if (!username) {
      setErrors({ username: 'Please enter a username.' })
      return
    }
    if (!validateEmail(username)) {
      setErrors({ username: 'You must enter a valid email address.' })
      return
    }
    try {
      track('auth_email_submitted', { source: 'auth' })
      const exists = await checkUserExists(username)
      if (exists) {
        track('auth_user_exists', { source: 'auth' })
        setAuthStep('login')
      } else {
        if (isInviteWallEntry && !hasInvite) {
          track('auth_invite_required', { source: 'auth' })
          setErrors({ form: 'Janata is invite-only. Paste an invite to create an account.' })
          return
        }
        // form-03 cut (#403): the invite is the door, so a new email goes
        // straight to account creation. Manual codes enter via /join (new-25).
        track('auth_user_new', { source: 'auth' })
        setAuthStep('signup')
      }
    } catch (e: any) {
      track('auth_check_failed', { source: 'auth' })
      setErrors({ form: e.message || 'Failed to connect to server.' })
    }
  }, [username, checkUserExists, track, isInviteWallEntry, hasInvite])

  const handleLogin = useCallback(async () => {
    setErrors({})
    if (!username) {
      setErrors({ username: 'Please enter a username.' })
      return
    }
    if (!password) {
      setErrors({ password: 'Please enter your password.' })
      return
    }
    try {
      const result = await login(username, password)
      if (result.success) {
        track('login_success', { source: 'auth' })
        // new-22 grandfather upgrade: apply an invite held through login (a
        // collision flip or Door 1's "Already a member?") so an existing
        // open-signup account gets promoted. Best-effort — never blocks login.
        const heldCode = extractInviteCode(inviteCode)
        if (heldCode) {
          try {
            const token = await getToken()
            if (token) await inviteClient.redeem(token, heldCode)
            track('invite_applied_on_login', { source: 'auth' })
          } catch {
            // ignore — login already succeeded
          }
        }
        router.replace(returnTo ? (returnTo as never) : '/(tabs)')
      } else {
        track('login_failed', { source: 'auth', reason: result.message })
        setErrors({ form: result.message || 'Username or password is incorrect.' })
      }
    } catch (e: any) {
      track('login_failed', { source: 'auth', reason: 'network_error' })
      setErrors({ form: 'Failed to connect to server. Please try again.' })
    }
  }, [username, password, inviteCode, login, getToken, router, track, returnTo])

  const handleSignup = useCallback(async () => {
    setErrors({})
    if (!username) {
      setErrors({ username: 'Please enter a username.' })
      return
    }
    if (!password) {
      setErrors({ password: 'Please enter a password.' })
      return
    }
    if (!validatePassword(password).isValid) {
      setErrors({ password: 'Password does not meet complexity requirements.' })
      return
    }
    if (password !== confirmPassword) {
      setErrors({ confirmPassword: 'Passwords do not match.' })
      return
    }
    try {
      const result = await signup(username, password, extractInviteCode(inviteCode))
      if (result.success) {
        track('signup_success', { source: 'auth' })
        router.replace(
          returnTo ? `/onboarding?returnTo=${encodeURIComponent(returnTo)}` : '/onboarding',
        )
      } else if (/already exists/i.test(result.message || '')) {
        // new-22: email already registered → flip to login holding the invite,
        // applied after login (handleLogin) to upgrade a grandfathered account.
        track('auth_email_collision', { source: 'auth' })
        setCollisionFlip(true)
        setAuthStep('login')
        setPassword('')
        setConfirmPassword('')
        setErrors({})
      } else {
        track('signup_failed', { source: 'auth', reason: result.message })
        setErrors({ form: result.message || 'Failed to sign up. Please try again.' })
      }
    } catch (e: any) {
      track('signup_failed', { source: 'auth', reason: 'network_error' })
      setErrors({ form: 'Failed to connect to server. Please try again.' })
    }
  }, [username, password, confirmPassword, inviteCode, signup, router, track, returnTo])

  const handleSubmit = useCallback(
    (e?: any) => {
      if (e?.preventDefault) {
        e.preventDefault()
        e.stopPropagation?.()
      }
      if (authStep === 'login') handleLogin()
      else if (authStep === 'signup') handleSignup()
      else handleContinue()
    },
    [authStep, handleLogin, handleSignup, handleContinue],
  )

  const handleBack = useCallback(() => {
    track('auth_back_pressed', { source: 'auth', from_step: authStep })
    setAuthStep('initial')
    setPassword('')
    setConfirmPassword('')
    setInviteCode('')
    setCollisionFlip(false)
    setErrors({})
  }, [authStep, track])

  // Web "Create one" affordance: validate the email, then route to login or
  // signup. (Native reaches signup through handleContinue.)
  const createAccount = useCallback(async () => {
    if (!username) {
      setErrors({ username: 'Please enter your email first.' })
      return
    }
    if (!validateEmail(username)) {
      setErrors({ username: 'You must enter a valid email address.' })
      return
    }
    if (isInviteWallEntry && !hasInvite) {
      setErrors({ form: 'Janata is invite-only. Paste an invite to create an account.' })
      return
    }
    track('auth_create_account_pressed', { source: 'auth' })
    try {
      const exists = await checkUserExists(username)
      if (exists) {
        setErrors({ form: 'An account with this email already exists. Please log in.' })
        setAuthStep('login')
      } else {
        setAuthStep('signup')
      }
    } catch (e: any) {
      setErrors({ form: e.message || 'Failed to connect to server.' })
    }
  }, [username, checkUserExists, track, isInviteWallEntry, hasInvite])

  const isButtonDisabled =
    loading ||
    (authStep === 'initial' && !username) ||
    (authStep !== 'initial' && !password) ||
    (authStep === 'signup' && !confirmPassword)

  const errorMessages = Object.values(errors).filter(Boolean)

  const inviteEmailStep = authStep === 'initial' && hasInvite
  const inviteWallStep = authStep === 'initial' && isInviteWallEntry && !hasInvite

  const heading =
    authStep === 'login'
      ? collisionFlip
        ? 'You already have an account'
        : 'Welcome back.'
      : authStep === 'signup'
        ? 'Join the community.'
        : 'Welcome'

  const subtitle =
    authStep === 'login'
      ? collisionFlip
        ? "Log in and we'll apply the invite to it."
        : 'Enter your password to continue'
      : authStep === 'signup'
        ? hasInvite
          ? 'Create your account to accept this invite'
          : 'Create your account to get started'
        : inviteEmailStep
          ? 'Enter your email to accept this Janata invite.'
          : inviteWallStep
            ? "Log in with your member account, or paste an invite if you're new."
          : 'Enter your email to get started'

  return {
    // state
    authStep,
    username,
    password,
    confirmPassword,
    errors,
    errorMessages,
    collisionFlip,
    loading,
    // derived
    inviterName,
    hasInvite,
    isInviteWallEntry,
    emailEditable,
    isButtonDisabled,
    heading,
    subtitle,
    // change handlers (value-based; web wraps with e => change(e.target.value))
    changeUsername,
    changePassword,
    changeConfirm,
    // actions
    handleSubmit,
    handleBack,
    createAccount,
  }
}

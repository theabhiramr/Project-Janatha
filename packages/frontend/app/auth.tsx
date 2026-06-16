import React, { useState } from 'react'
import {
  View,
  Text,
  Platform,
  ScrollView,
  Pressable,
  TouchableOpacity,
  ViewStyle,
} from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowLeft } from 'lucide-react-native'
import { useAnalytics } from '../utils/analytics'
import { AuthInput, Logo, PrimaryButton } from '../components/ui'
import { useTheme } from '../components/contexts'
import { PasswordStrength } from '../components'
import DevPanel from '../components/DevPanel'
import { useAuthFlow } from '../components/auth/useAuthFlow'
import { InviteCodeInput } from '../components/invite/InviteCodeField'
import { extractInviteCode } from '../utils/validation'

// __DEV__ is a React Native/Expo global — always false in production builds.
// EXPO_PUBLIC_SHOW_DEV_TOOLS=1 also enables the dev/demo tools (set on the
// isolated v2 preview build), so role-switching works for demos there too.
const isDev =
  (typeof __DEV__ !== 'undefined' && __DEV__) ||
  process.env.EXPO_PUBLIC_SHOW_DEV_TOOLS === '1'

export default function AuthScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { isDark } = useTheme()
  const { track } = useAnalytics()
  const pageBg = isDark ? '#171717' : '#FAFAF7'
  const textColor = isDark ? '#FAFAFA' : '#1C1917'
  const mutedColor = isDark ? '#A8A29E' : '#78716C'
  const topPadding = Math.max(insets.top + 118, 132)

  // All auth state + handlers live in the shared hook (see auth.web.tsx — same
  // logic, different presentation). This file is RN markup only.
  const {
    authStep,
    username,
    password,
    confirmPassword,
    errorMessages,
    loading,
    inviterName,
    hasInvite,
    isInviteWallEntry,
    emailEditable,
    isButtonDisabled,
    heading,
    subtitle,
    changeUsername,
    changePassword,
    changeConfirm,
    handleSubmit,
    handleBack,
  } = useAuthFlow()

  const [showDevPanel, setShowDevPanel] = useState(false)
  const [showInviteField, setShowInviteField] = useState(false)
  const [inviteValue, setInviteValue] = useState('')
  const [inviteError, setInviteError] = useState('')

  const revealInviteField = () => {
    track('auth_have_invite_pressed', { source: 'auth' })
    setShowInviteField(true)
  }

  const hideInviteField = () => {
    track('auth_invite_entry_cancelled', { source: 'auth' })
    setShowInviteField(false)
    setInviteValue('')
    setInviteError('')
  }

  const openInvite = (code: string) => {
    track('auth_invite_code_submitted', { source: 'auth' })
    router.push(`/i/${encodeURIComponent(code)}` as never)
  }

  const submitInvite = () => {
    const code = extractInviteCode(inviteValue)
    if (!code) {
      setInviteError('Paste a valid invite link or code.')
      return
    }
    setInviteError('')
    openInvite(code)
  }

  const handlePrimaryPress = () => {
    if (showInviteField && inviteValue.trim()) {
      submitInvite()
      return
    }
    handleSubmit()
  }

  const inviteHasText = showInviteField && inviteValue.trim().length > 0
  const primaryDisabled = inviteHasText ? loading : isButtonDisabled
  const rootStyle: ViewStyle = { flex: 1, backgroundColor: pageBg }

  return (
    <View style={rootStyle}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: 24,
          paddingTop: topPadding,
          paddingBottom: 32,
        }}
        style={{ flex: 1, backgroundColor: pageBg }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        automaticallyAdjustKeyboardInsets
      >
        {/* Guest browse link, top-right, initial step only. Lets a logged-out
            user browse the app before signing up (mirrors the web version). */}
        {authStep === 'initial' && (
          <Pressable
            onPress={() => { track('auth_browse_as_guest_pressed', { source: 'auth' }); router.push('/explore') }}
            className="absolute right-5"
            style={{ top: insets.top + 12, paddingHorizontal: 4, paddingVertical: 8 }}
          >
            <Text className="font-sans" style={{ fontSize: 14.5, fontWeight: '500', color: '#E8862A' }}>
              Browse as guest
            </Text>
          </Pressable>
        )}

        {/* Main content */}
        <View className="w-full items-center">
          {/* Container */}
          <View className="w-full" style={{ maxWidth: 400 }}>
            {/* Back Button */}
            {authStep !== 'initial' && (
              <TouchableOpacity
                onPress={handleBack}
                activeOpacity={0.7}
                className="flex-row items-center gap-2 mb-6 rounded-xl px-3 py-2 self-start"
                style={{ alignSelf: 'flex-start' }}
              >
                <ArrowLeft size={20} className={isDark ? 'text-white' : 'text-content'} />
                <Text className="font-sans font-medium text-content dark:text-content-dark">Back</Text>
              </TouchableOpacity>
            )}

            {/* Janata Wordmark */}
            <Pressable
              onPress={() => { track('auth_logo_pressed', { source: 'auth' }); router.push('/landing') }}
              onLongPress={isDev ? () => setShowDevPanel(true) : undefined}
            >
              <Logo size={30} style={{ marginBottom: 42 }} />
            </Pressable>

            {/* Heading & Subtitle */}
            <View style={{ marginBottom: 26 }}>
              <Text
                style={{ fontFamily: '"Inclusive Sans"', fontSize: 36, lineHeight: 43, fontWeight: '400', color: textColor }}
              >
                {heading}
              </Text>

              <Text className="text-base font-sans" style={{ color: mutedColor, lineHeight: 24, marginTop: 10 }}>
                {subtitle}
              </Text>
            </View>

            {/* Applied-invite bar (#403): the vouch carries into account
                creation, and is "held" when an email collision flips to login. */}
            {hasInvite && (authStep === 'signup' || authStep === 'login') && (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  backgroundColor: 'rgba(232,134,42,0.1)',
                  borderRadius: 12,
                  paddingVertical: 12,
                  paddingHorizontal: 14,
                  marginBottom: 16,
                }}
              >
                <Text style={{ fontSize: 15 }}>🪔</Text>
                <Text className="font-sans" style={{ flex: 1, fontSize: 14, lineHeight: 20, color: '#B05A12' }}>
                  <Text style={{ fontWeight: '700', color: '#E8862A' }}>
                    {inviterName ? `${inviterName}'s invite applied.` : 'Invite applied.'}
                  </Text>
                  {authStep === 'signup'
                    ? " You're a member the moment you finish."
                    : ' Held while you log in.'}
                </Text>
              </View>
            )}

            {/* Errors */}
            {errorMessages.length > 0 && (
              <View className="w-full font-sans bg-red-50 dark:bg-red-900/20 rounded-xl px-4 py-3 mb-4">
                {errorMessages.map((msg, idx) => (
                  <Text key={idx} className="text-red-500 text-sm font-sans">
                    {msg}
                  </Text>
                ))}
              </View>
            )}

            {/* Form */}
            <View style={{ gap: showInviteField ? 8 : 16 }}>
              <View>
                <AuthInput
                  placeholder="Email"
                  onChangeText={changeUsername}
                  value={username}
                  secureTextEntry={false}
                  editable={emailEditable}
                />
              </View>
              {authStep === 'login' && (
                <View>
                  <AuthInput
                    placeholder="Password"
                    onChangeText={changePassword}
                    value={password}
                    secureTextEntry
                    autoComplete="password"
                    style={{}}
                  />
                </View>
              )}

              {authStep === 'signup' && (
                <>
                  <View>
                    <PasswordStrength password={password} show={password.length > 0} />
                    <AuthInput
                      placeholder="Password"
                      onChangeText={changePassword}
                      value={password}
                      secureTextEntry
                      autoComplete="password-new"
                      style={{}}
                    />
                  </View>
                  <View>
                    <AuthInput
                      placeholder="Confirm password"
                      onChangeText={changeConfirm}
                      value={confirmPassword}
                      secureTextEntry
                      autoComplete="password-new"
                      style={{}}
                    />
                  </View>
                </>
              )}

              {authStep === 'initial' && !hasInvite && showInviteField && (
                <InviteCodeInput
                  compact
                  value={inviteValue}
                  onChangeText={(next) => {
                    setInviteValue(next)
                    if (inviteError) setInviteError('')
                  }}
                  error={inviteError}
                  onSubmitEditing={submitInvite}
                />
              )}

              {/* Submit Button */}
              <PrimaryButton
                onPress={handlePrimaryPress}
                disabled={primaryDisabled}
                loading={loading}
                style={{ marginTop: showInviteField ? 0 : 8 }}
              >
                {authStep === 'login'
                  ? 'Log In'
                  : authStep === 'signup'
                    ? hasInvite
                      ? 'Accept Invite'
                      : 'Sign Up'
                    : 'Continue'}
              </PrimaryButton>

              {authStep === 'initial' && !hasInvite && showInviteField && (
                <Pressable
                  className="items-center"
                  onPress={hideInviteField}
                >
                  <Text className="font-sans" style={{ fontSize: 14, color: mutedColor }}>
                    No invite? <Text style={{ color: '#E8862A', fontWeight: '600' }}>Use email instead</Text>
                  </Text>
                </Pressable>
              )}

              {/* Forgot Password (only on login) */}
              {authStep === 'login' && (
                <Pressable
                  className="items-center mt-2"
                  onPress={() => { track('auth_forgot_password_pressed', { source: 'auth' }); router.push('/auth/forgot') }}
                >
                  <Text className="text-primary font-sans font-medium">Forgot password?</Text>
                </Pressable>
              )}

              {/* Have an invite? — reveal the same paste field used by /join and the modal. */}
              {authStep === 'initial' && !hasInvite && (
                !showInviteField && (
                  <Pressable
                    className="items-center mt-4"
                    onPress={revealInviteField}
                  >
                    <Text className="font-sans" style={{ fontSize: 14, color: mutedColor }}>
                      Have an invite? <Text style={{ color: '#E8862A', fontWeight: '600' }}>Paste it</Text>
                    </Text>
                  </Pressable>
                )
              )}
            </View>

            {/* Footer Text */}
            <Text className="text-sm font-sans mt-8 text-center px-4" style={{ color: mutedColor, opacity: 0.78, lineHeight: 20 }}>
              By continuing, you agree to our{' '}
              <Text
                className="text-primary font-sans"
                onPress={() => { track('terms_viewed', { source: 'auth' }); router.push('/terms') }}
              >
                Terms of Service
              </Text>
              {' '}and{' '}
              <Text
                className="text-primary font-sans"
                onPress={() => { track('privacy_policy_viewed', { source: 'auth' }); router.push('/privacy') }}
              >
                Privacy Policy
              </Text>
            </Text>
          </View>
        </View>
      </ScrollView>
      {isDev && showDevPanel && (
        <DevPanel visible={showDevPanel} onClose={() => setShowDevPanel(false)} />
      )}
    </View>
  )
}

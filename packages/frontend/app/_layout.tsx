import '@expo/metro-runtime'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Animated, LogBox, Platform, Text, View, useWindowDimensions } from 'react-native'

// Suppress non-fatal WorkletsTurboModule error in Expo Go (reanimated v4 compat)
LogBox.ignoreLogs([
  'Exception in HostFunction: <unknown>',
  'SafeAreaView has been deprecated',
])
import {
  InclusiveSans_300Light,
  InclusiveSans_400Regular,
  InclusiveSans_500Medium,
  InclusiveSans_600SemiBold,
  InclusiveSans_700Bold,
} from '@expo-google-fonts/inclusive-sans'
import { JetBrainsMono_400Regular, JetBrainsMono_700Bold } from '@expo-google-fonts/jetbrains-mono'
import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider as NavigationThemeProvider,
} from '@react-navigation/native'
import { useFonts } from 'expo-font'
import * as SplashScreen from 'expo-splash-screen'
import { Stack, usePathname, useRouter } from 'expo-router'
import { PostHogProvider, PostHogSurveyProvider } from 'posthog-react-native'
import {
  UserProvider,
  useUser,
  ThemeProvider as CustomThemeProvider,
  useTheme,
} from '../components/contexts'
import { ErrorBoundaryWithAnalytics } from '../components/ui/ErrorBoundary'
import WebBottomNav from '../components/ui/WebBottomNav'
import { AnalyticsScreenTracker, AnalyticsBootstrap } from '../utils/analytics'
import { supportsNativeDriver } from '../utils/animation'
import { usePushNotifications } from '../hooks/usePushNotifications'
import { getIntroShown } from '../utils/introStorage'
import '../globals.css'

export const unstable_settings = {
  initialRouteName: '(tabs)',
}

SplashScreen.preventAutoHideAsync()
SplashScreen.setOptions({ duration: 350, fade: true })

const posthogHost = process.env.EXPO_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com'
const posthogKey = process.env.EXPO_PUBLIC_POSTHOG_KEY
const posthogEnabled = !!(posthogKey && posthogKey.trim().length > 0)

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    'Inclusive Sans': InclusiveSans_400Regular,
    'Inclusive Sans Bold': InclusiveSans_700Bold,
    'Inclusive Sans SemiBold': InclusiveSans_600SemiBold,
    'Inclusive Sans Medium': InclusiveSans_500Medium,
    'Inclusive Sans Light': InclusiveSans_300Light,
    'JetBrains Mono': JetBrainsMono_400Regular,
    'JetBrains Mono Bold': JetBrainsMono_700Bold,
  })

  const readyFlags = useRef({ auth: false, minTime: false })
  const hideStarted = useRef(false)

  const tryHide = useCallback(() => {
    if (hideStarted.current) return
    if (!readyFlags.current.auth || !readyFlags.current.minTime) return
    hideStarted.current = true
    SplashScreen.hideAsync().catch(() => {})
  }, [])

  useEffect(() => {
    if (!fontsLoaded) return
    const TextAny = Text as any
    const defaultProps = TextAny.defaultProps || {}
    TextAny.defaultProps = {
      ...defaultProps,
      style: [{ fontFamily: 'Inclusive Sans' }, defaultProps.style],
    }
    const timer = setTimeout(() => {
      readyFlags.current.minTime = true
      tryHide()
    }, 3000)
    return () => clearTimeout(timer)
  }, [fontsLoaded, tryHide])

  const handleAuthReady = useCallback(() => {
    readyFlags.current.auth = true
    tryHide()
  }, [tryHide])

  if (!fontsLoaded) return null

  // Always provide a PostHog context so usePostHog() (UserContext, useAnalytics,
  // ErrorBoundaryWithAnalytics, AnalyticsScreenTracker) never throws. Without a
  // key (local/dev, or a preview built without one) the client is `disabled` —
  // no network, capture() is a no-op — rather than rendering no provider at all,
  // which made usePostHog() crash the app on load.
  return (
    <PostHogProvider
      apiKey={posthogEnabled ? posthogKey!.trim() : 'phc_disabled'}
      options={{
        host: posthogHost,
        disabled: !posthogEnabled,
        disableRemoteConfig: !posthogEnabled,
        disableSurveys: !posthogEnabled,
        preloadFeatureFlags: posthogEnabled,
        // Capture app opened / backgrounded / became active lifecycle events.
        captureAppLifecycleEvents: posthogEnabled,
        // Mobile session replay (iOS/Android only; no-op on web). Also requires
        // "Record user sessions" enabled in PostHog project settings, where the
        // sample rate is set so we stay inside the free replay quota without a
        // client release. Text inputs are masked; images are left visible since
        // feed/profile imagery is the point of a session we'd want to watch.
        enableSessionReplay: posthogEnabled && Platform.OS !== 'web',
        sessionReplayConfig: {
          maskAllTextInputs: true,
          maskAllImages: false,
          captureLog: true,
          captureNetworkTelemetry: true,
        },
        // Auto-capture crashes the React ErrorBoundary can't see (uncaught JS
        // errors, unhandled promise rejections). Console capture stays off to
        // avoid event-volume noise.
        errorTracking: {
          autocapture: {
            uncaughtExceptions: true,
            unhandledRejections: true,
            console: false,
          },
        },
      }}
      // Screens are tracked manually via <AnalyticsScreenTracker /> below, and
      // touch autocapture is too noisy — disable both.
      autocapture={{
        captureScreens: false,
        captureTouches: false,
      }}
    >
      {posthogEnabled ? <AnalyticsScreenTracker /> : null}
      {posthogEnabled ? <AnalyticsBootstrap /> : null}
      <ErrorBoundaryWithAnalytics>
        <CustomThemeProvider>
          <UserProvider>
            {posthogEnabled ? (
              <PostHogSurveyProvider>
                <RootLayoutNav onAuthReady={handleAuthReady} />
              </PostHogSurveyProvider>
            ) : (
              <RootLayoutNav onAuthReady={handleAuthReady} />
            )}
          </UserProvider>
        </CustomThemeProvider>
      </ErrorBoundaryWithAnalytics>
    </PostHogProvider>
  )
}

function RootLayoutNav({ onAuthReady }: { onAuthReady: () => void }) {
  const { user, loading } = useUser()
  const { isDark } = useTheme()
  const pathname = usePathname()
  const router = useRouter()
  const isAuthenticated = !!user
  // Register for push + route notification taps once authenticated (#102).
  usePushNotifications()
  const { width } = useWindowDimensions()
  // First-timer explainer gate. null = not yet resolved (don't redirect yet).
  const [introShown, setIntroShown] = useState<boolean | null>(null)

  useEffect(() => {
    let active = true
    getIntroShown()
      .then((seen) => {
        if (active) setIntroShown(seen)
      })
      .catch(() => {
        // On any failure, treat as "shown" so we never trap the user pre-auth.
        if (active) setIntroShown(true)
      })
    return () => {
      active = false
    }
  }, [])
  // Mirrors the desktop WebHeader, which shows its nav regardless of auth —
  // only hide on the full-screen landing/auth/onboarding flows.
  const showBottomNav =
    Platform.OS === 'web' &&
    width < 768 &&
    !pathname.startsWith('/auth') &&
    !pathname.startsWith('/onboarding') &&
    pathname !== '/join' &&
    !pathname.startsWith('/i/') &&
    pathname !== '/landing' &&
    pathname !== '/intro'

  useEffect(() => {
    if (!loading) {
      onAuthReady()
    }
  }, [loading, onAuthReady])

  useEffect(() => {
    if (loading) return
    // Wait until the intro-shown flag has resolved before redirecting, so we
    // don't briefly route a first-timer to landing/auth before /intro.
    if (introShown === null) return

    const inAuthGroup = pathname.startsWith('/auth')
    const inOnboardingGroup = pathname.startsWith('/onboarding')
    const inLandingPage = pathname === '/landing'
    const inIntroPage = pathname === '/intro'

    if (!isAuthenticated) {
      // First-run-only: an unauthenticated first-timer is shown /intro ONLY when
      // they hit the natural entry surface (root or landing). Public deep links
      // (/events/:id, /center/:id, /feed, /explore, SEO pages) are NOT
      // intercepted, so shared/indexed links open directly. Skip → /auth always
      // works (it sets intro-shown), so the user is never trapped.
      const isEntrySurface = pathname === '/' || inLandingPage
      // Native-only first-run: the /intro explainer is for first-time iOS app
      // users. On web, visitors land on the marketing site (/landing) — don't
      // bounce them into /intro (which also broke "Back to home" from /auth).
      if (Platform.OS !== 'web' && !introShown && isEntrySurface && !inIntroPage) {
        router.replace('/intro')
        return
      }

      const isPublicPage =
        inAuthGroup ||
        inIntroPage ||
        inLandingPage ||
        pathname === '/' ||
        pathname.startsWith('/(tabs)') ||
        pathname === '/explore' ||
        pathname.startsWith('/explore/') ||
        pathname === '/feed' ||
        pathname.startsWith('/feed/') ||
        pathname.startsWith('/events/') ||
        pathname.startsWith('/center/') ||
        pathname.startsWith('/i/') ||
        pathname.startsWith('/invite/') ||
        pathname === '/join' ||
        pathname.startsWith('/privacy') ||
        pathname.startsWith('/terms') ||
        pathname.startsWith('/cookies')

      if (!isPublicPage) {
        router.replace('/landing')
      }
    } else {
      // Authenticated users never see the intro; if they land on it, move on.
      if (inIntroPage) {
        router.replace('/')
        return
      }
      const isComplete = user.profileComplete || (!!user.firstName && !!user.lastName)

      if (!isComplete) {
        if (!inOnboardingGroup) {
          router.replace('/onboarding')
        }
      } else {
        if (inAuthGroup || inOnboardingGroup) {
          router.replace('/')
        }
      }
    }
  }, [user, loading, pathname, isAuthenticated, introShown])

  const navTheme = isDark ? DarkTheme : DefaultTheme
  const rootBackground = isDark ? '#1A1A1A' : '#FAFAF7'
  const prevIsDark = useRef(isDark)
  const fadeAnim = useRef(new Animated.Value(1)).current

  useEffect(() => {
    if (prevIsDark.current !== isDark) {
      prevIsDark.current = isDark
      Animated.sequence([
        Animated.timing(fadeAnim, { toValue: 0.85, duration: 80, useNativeDriver: supportsNativeDriver }),
        Animated.timing(fadeAnim, { toValue: 1, duration: 150, useNativeDriver: supportsNativeDriver }),
      ]).start()
    }
  }, [isDark, fadeAnim])

  if (loading) return null

  return (
    <Animated.View style={{ flex: 1, backgroundColor: rootBackground, opacity: fadeAnim }}>
      <NavigationThemeProvider value={navTheme}>
        <View style={{ flex: 1, backgroundColor: rootBackground }}>
        <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="auth" options={{ headerShown: false }} />
          <Stack.Screen name="intro" options={{ headerShown: false, gestureEnabled: false }} />
          <Stack.Screen name="landing" options={{ headerShown: false }} />
          <Stack.Screen name="onboarding" options={{ headerShown: false, gestureEnabled: false }} />
          <Stack.Screen name="settings" options={{ headerShown: false }} />
          <Stack.Screen name="notifications" options={{ headerShown: false }} />
          <Stack.Screen
            name="events/index"
            options={{ headerShown: true, title: 'My Events', headerBackTitle: '' }}
          />
          <Stack.Screen name="events/[id]" options={{ headerShown: false }} />
          <Stack.Screen name="events/form" options={{ headerShown: false }} />
          <Stack.Screen name="center/[id]" options={{ headerShown: false }} />
          <Stack.Screen
            name="privacy"
            options={{
              headerShown: Platform.OS !== 'web',
              title: 'Privacy Policy',
              headerBackTitle: '',
            }}
          />
          <Stack.Screen
            name="terms"
            options={{
              headerShown: Platform.OS !== 'web',
              title: 'Terms of Service',
              headerBackTitle: '',
            }}
          />
          <Stack.Screen
            name="cookies"
            options={{
              headerShown: Platform.OS !== 'web',
              title: 'Cookie Policy',
              headerBackTitle: '',
            }}
          />
          <Stack.Screen name="edit-profile" options={{ headerShown: false }} />
          <Stack.Screen name="center-picker" options={{ headerShown: false }} />
          <Stack.Screen name="admin" options={{ headerShown: false }} />
        </Stack>
        </View>
        {showBottomNav && <WebBottomNav />}
      </NavigationThemeProvider>
    </Animated.View>
  )
}

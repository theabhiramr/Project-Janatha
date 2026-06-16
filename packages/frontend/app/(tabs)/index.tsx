import React, { useCallback, useMemo, useState } from 'react'
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native'
import { ChevronRight, Compass, MapPin, Shield } from 'lucide-react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { useAnalytics } from '../../utils/analytics'
import { useUser } from '../../components/contexts'
import { isSuperAdmin } from '../../utils/admin'
import { useColors } from '../../hooks/useColors'
import { useDetailColors } from '../../hooks/useDetailColors'
import { useDiscoverData, useMyEvents, useBoard } from '../../hooks/useApiData'
import type { DiscoverCenter, EventDisplay } from '../../utils/api'
import { extractCityState } from '../../utils/addressParsing'
import { FeaturedEventCard, type FeaturedSource } from '../../components/home/FeaturedEventCard'
import { MiniEventRow, type WeekItem } from '../../components/home/MiniEventRow'
import { BoardPostCard, SignInCallout, boardPostToMessage, type BoardMessage } from '../../components/boards'
import { FeedSetupRail } from '../../components/feed'
import { DesktopColumns, desktopScrollContent, useDesktopLayout } from '../../components/layout/DesktopColumns'
import AuthPromptModal from '../../components/ui/AuthPromptModal'
import type { AppColors } from '../../tokens'

const compassImage = require('../../assets/images/onboarding/compass.png')

function formatDatePill(dateStr: string): { month: string; day: string } {
  const parsed = new Date(`${dateStr}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return { month: '', day: '' }
  return {
    month: parsed.toLocaleDateString('en-US', { month: 'short' }).toUpperCase(),
    day: String(parsed.getDate()),
  }
}

function isToday(dateStr: string): boolean {
  return dateStr === new Date().toISOString().split('T')[0]
}

function sortUpcomingEvents(events: EventDisplay[]) {
  const today = new Date().toISOString().split('T')[0]
  return [...events]
    .filter((e) => !e.date || e.date >= today)
    .sort((a, b) => {
      if (!a.date && !b.date) return 0
      if (!a.date) return 1
      if (!b.date) return -1
      return a.date.localeCompare(b.date)
    })
}

function liveEventToWeekItem(event: EventDisplay, onPress: () => void): WeekItem {
  const { month, day } = event.date ? formatDatePill(event.date) : { month: '', day: '' }
  const today = event.date ? isToday(event.date) : false
  return {
    id: event.id,
    month,
    day,
    title: event.title,
    subtitle: [today ? 'Today' : event.time || 'TBD', event.location || event.address].filter(Boolean).join(' · '),
    highlight: today,
    onPress,
  }
}

export default function HomeScreen() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const { track } = useAnalytics()
  const { user } = useUser()
  const [showAuthPrompt, setShowAuthPrompt] = useState(false)
  const c = useColors()
  const detailColors = useDetailColors()
  const { events: myEvents, loading: myEventsLoading, refetch: refetchMyEvents } = useMyEvents(user?.username)
  const { allEvents, allCenters, loading: discoverLoading, refresh: refreshDiscover } = useDiscoverData(
    'Events', '', user?.id, false, false, user?.interests ?? undefined, user?.centerID
  )

  // Boards peek (#199): surface the 1-2 latest posts from the user's center
  // board so Home reflects real activity instead of a permanent empty state.
  const { posts: centerBoardPosts } = useBoard('center', user?.centerID ?? undefined, !!user?.centerID)
  const userCenter = useMemo(
    () => allCenters.find((item) => item.id === user?.centerID),
    [allCenters, user?.centerID]
  )
  const centerName = userCenter?.name
  const boardPeek = useMemo(
    () =>
      centerBoardPosts.slice(0, 2).map((post) => ({
        ...boardPostToMessage(post),
        sourceKind: 'center' as const,
        sourceLabel: centerName ?? 'Your center',
      })),
    [centerBoardPosts, centerName]
  )

  useFocusEffect(
    useCallback(() => {
      refetchMyEvents()
      refreshDiscover()
    }, [refetchMyEvents, refreshDiscover])
  )

  // Desktop two-column composition is web-only and gated on a wide breakpoint.
  // Mobile web and native always render the original single centered column.
  const isWideDesktop = useDesktopLayout(width)
  const isDesktop = width >= 860

  const signedUpEvents = useMemo(() => {
    const fromDiscover = sortUpcomingEvents(allEvents.filter((e) => e.isRegistered))
    if (fromDiscover.length > 0) return fromDiscover
    return sortUpcomingEvents(myEvents.map((e) => ({ ...e, isRegistered: true })))
  }, [allEvents, myEvents])

  const upcomingExploreEvents = useMemo(
    () => sortUpcomingEvents(allEvents.filter((e) => !e.isRegistered)),
    [allEvents]
  )

  const featured = useMemo<FeaturedSource | null>(() => {
    const source = signedUpEvents[0] || upcomingExploreEvents[0]
    if (source) {
      const centerName = allCenters.find((item) => item.id === source.centerId)?.name
      return { kind: 'live', event: source, centerName }
    }
    return null
  }, [allCenters, signedUpEvents, upcomingExploreEvents])

  const weekItems = useMemo<WeekItem[]>(() => {
    const featuredId = featured?.event.id ?? null
    const pool = (signedUpEvents.length > 0 ? signedUpEvents : upcomingExploreEvents).filter(
      (e) => e.id !== featuredId
    )
    if (pool.length === 0) return []
    return pool.slice(0, 4).map((event) =>
      liveEventToWeekItem(event, () => {
        track('home_event_pressed', { eventId: event.id, source: 'this_week' })
        router.push(`/events/${event.id}`)
      })
    )
  }, [featured, track, router, signedUpEvents, upcomingExploreEvents])

  const greetingName = user?.firstName || user?.username || 'friend'
  const todayLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  // Role + login personalization (goal): under the name, reflect who the member
  // is — their verification role and home center — so Home greets a Sevak at
  // Chinmaya San Jose differently from a brand-new guest. Empty for guests and
  // for members with neither a role nor a center (the GET CONNECTED card leads
  // those users instead).
  const vl = user?.verificationLevel ?? 0
  const roleLabel =
    vl >= 1000008 ? 'Global Head'
      : vl >= 1008 ? 'Swami'
      : vl >= 108 ? 'Brahmachari'
      : vl >= 54 ? 'Sevak'
      : vl >= 45 ? 'Verified member'
      : null
  const greetingSubline = user ? [roleLabel, centerName].filter(Boolean).join('  ·  ') : ''

  // First run: a member still in discovery mode — hasn't joined an event yet.
  // Give them one tight welcome line, a card for their center, and a peek at
  // their board feed when there's activity. Real Up Next / Coming Up content
  // still renders below, so Home leads with useful content rather than a
  // redundant feature tour. Self-resolves once they RSVP.
  const isNewUser = !!user && signedUpEvents.length === 0
  // A signed-in, verified member (vl >= 45). Guests and unverified users get the
  // stripped home: Explore + sign-in nudge, no personalized event/board lists.
  const isVerifiedMember = !!user && vl >= 45
  const isLoggedOutWeb = Platform.OS === 'web' && !user

  const shouldWaitForHomeData = user ? (discoverLoading || myEventsLoading) : (!isLoggedOutWeb && discoverLoading)
  if (shouldWaitForHomeData) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg }}>
        <ActivityIndicator size="large" color={c.accent} />
      </View>
    )
  }

  const greeting = (
    <View style={{ gap: 4 }}>
      <Text style={{ fontSize: 12.5, color: c.textFaint, letterSpacing: 0.2 }}>{todayLabel}</Text>
      <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 30, lineHeight: 34, letterSpacing: -0.5, color: c.text }} numberOfLines={1}>
        {user ? `Namaste, ${greetingName}` : 'Namaste'}
      </Text>
      {greetingSubline ? (
        <Text style={{ fontSize: 13.5, color: c.textMuted, marginTop: 1 }} numberOfLines={1}>
          {greetingSubline}
        </Text>
      ) : null}
    </View>
  )

  // Login-state personalization: guests get a sign-in nudge that explains what
  // signing in unlocks; signed-in members don't.
  const guestNudge = !user ? (
    <SignInCallout
      title="Make Janata yours"
      subtitle="Log in or paste an invite to RSVP and join boards."
      ctaLabel="Log in"
      colors={c}
      onPress={() => {
        track('home_signin_pressed', { source: 'home_nudge' })
        setShowAuthPrompt(true)
      }}
    />
  ) : null

  const guestSetupRail = !user ? (
    <FeedSetupRail
      colors={c}
      isSignedIn={false}
      onSignIn={() => {
        track('home_signin_pressed', { source: 'home_desktop_rail' })
        setShowAuthPrompt(true)
      }}
      onJoinCenter={() => undefined}
      onBrowseEvents={() => {
        track('home_guest_browse_events_pressed', { source: 'home_desktop_rail' })
        router.push('/explore' as never)
      }}
      onPasteInvite={() => {
        track('home_paste_invite_pressed', { source: 'home_desktop_rail' })
        router.push('/join' as never)
      }}
      artworkSource={compassImage}
      signedOutTitle="Log in to make Janata yours."
      signedOutSubtitle="Your center, events, and community updates will show up here."
    />
  ) : null

  const authPrompt = (
    <AuthPromptModal
      visible={showAuthPrompt}
      onClose={() => setShowAuthPrompt(false)}
      returnTo="/"
      title="Make Janata yours."
      subtitle="Janata is invite-only — members join through a friend's invite. Log in, or paste one to get in."
      bullets={[
        'Follow your local center and see what is coming up',
        'RSVP to events and keep details handy',
        'Join boards for your center and gatherings',
      ]}
    />
  )

  // Role-aware: admins get a quick path to the dashboard from Home.
  const adminShortcut = isSuperAdmin(user) ? (
    <Pressable
      onPress={() => {
        track('home_admin_pressed', { source: 'home' })
        router.push('/admin' as never)
      }}
      accessibilityRole="button"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, padding: 14 }}
    >
      <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Shield size={18} color={c.accent} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 15, color: c.text }}>Admin dashboard</Text>
        <Text style={{ fontSize: 13, color: c.textMuted }}>Manage centers, events, and moderation</Text>
      </View>
      <ChevronRight size={18} color={c.textFaint} />
    </Pressable>
  ) : null

  // Guests don't get the banner anymore — their Home leads with live events
  // (new-30); the compact guestNudge below the content is the only callout.
  const welcomeBanner = (!!user && !isVerifiedMember) || isNewUser ? (
    <WelcomeBanner
      c={c}
      centerName={centerName || undefined}
      onExplore={() => {
        track('home_first_run_explore_pressed')
        router.push('/explore' as never)
      }}
    />
  ) : null

  // Only a verified new member gets the first-run overview; it can surface the
  // user's center + board peek, which the not-verified home must not show.
  const firstRunOverview = isNewUser && isVerifiedMember ? (
    <FirstRunOverview
      c={c}
      detailColors={detailColors}
      center={userCenter}
      peek={boardPeek}
      onFeed={() => {
        track('home_first_run_feed_pressed')
        router.push('/feed' as never)
      }}
      onChooseCenter={() => {
        track('home_first_run_center_pressed')
        router.push('/center-picker' as never)
      }}
      onOpenCenter={(id) => {
        track('home_first_run_center_opened', { centerId: id })
        router.push(`/center/${id}`)
      }}
      onPeekPress={(id) => {
        track('home_board_peek_pressed', { postId: id, source: 'first_run_peek' })
        router.push('/feed' as never)
      }}
    />
  ) : null

  // Guests get the same live section (new-30): real events at zero taps,
  // headed "Happening near you" instead of the personalized "Up next".
  const upNextSection = (!user || isVerifiedMember) && (!isNewUser || featured) ? (
    <SectionHeader eyebrow={user ? 'UP NEXT FOR YOU' : 'HAPPENING NEAR YOU'} trailing="See all" accentColor={c.accent} faintColor={c.textFaint} onTrailingPress={() => {
      track('home_see_all_pressed', { section: 'up_next' })
      router.push('/explore' as never)
    }}>
      {featured ? (
        <FeaturedEventCard
          featured={featured}
          onPress={() => {
            track('home_featured_event_pressed', { eventId: featured.event.id })
            router.push(`/events/${featured.event.id}`)
          }}
        />
      ) : (
        <View style={{ borderRadius: 18, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, padding: 16, gap: 10 }}>
          <View style={{ gap: 4 }}>
            <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 17, color: c.text }}>
              {user ? 'No upcoming events at your center yet' : 'No events nearby yet'}
            </Text>
            <Text style={{ fontSize: 14, lineHeight: 20, color: c.textMuted }}>
              {user
                ? "Explore other CHYK events while your center's calendar fills in."
                : 'Browse centers and events across the network.'}
            </Text>
          </View>
          <Pressable
            onPress={() => {
              track('home_explore_fallback_pressed', { source: 'up_next_empty' })
              router.push('/explore' as never)
            }}
            style={{ alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999, backgroundColor: c.accentSoft }}
          >
            <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 13, color: c.accent }}>Explore</Text>
          </Pressable>
        </View>
      )}
    </SectionHeader>
  ) : null

  // Boards peek (#199): the 1-2 latest posts from the user's center board.
  // New users get their center + a feed peek inside the first-run overview,
  // so this section is for returning members only.
  const boardsSection = isVerifiedMember && !isNewUser ? (
    <SectionHeader
      eyebrow="LATEST ON YOUR BOARDS"
      trailing="Open Feed"
      accentColor={c.accent}
      faintColor={c.textFaint}
      onTrailingPress={() => {
        track('home_open_feed_pressed', { source: 'boards_section_header' })
        router.push('/feed' as never)
      }}
    >
      {boardPeek.length > 0 ? (
        <View>
          {boardPeek.map((message) => (
            <BoardPostCard
              key={message.id}
              message={message}
              colors={detailColors}
              showSource
              onPress={() => {
                track('home_board_peek_pressed', { postId: message.id, source: 'boards_section' })
                router.push('/feed' as never)
              }}
            />
          ))}
        </View>
      ) : (
        <View style={{ borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, padding: 16, gap: 6 }}>
          <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 16, color: c.text }}>
            No posts yet on your boards
          </Text>
          <Text style={{ fontSize: 14, lineHeight: 20, color: c.textMuted }}>
            Conversations from your center and events you've joined will appear here. Head to the Feed to see what's new across the network.
          </Text>
        </View>
      )}
    </SectionHeader>
  ) : null

  const weekSection = (!user || isVerifiedMember) && (!isNewUser || weekItems.length > 0) ? (
    <SectionHeader
      eyebrow={signedUpEvents.length > 0 ? 'THIS WEEK' : 'COMING UP'}
      trailing="See all"
      accentColor={c.accent}
      faintColor={c.textFaint}
      onTrailingPress={() => {
        track('home_see_all_pressed', { section: signedUpEvents.length > 0 ? 'this_week' : 'coming_up' })
        router.push((signedUpEvents.length > 0 ? '/explore?going=1' : '/explore') as never)
      }}
    >
      {weekItems.length > 0 ? (
        <View style={{ gap: 8 }}>
          {weekItems.map((item) => <MiniEventRow key={item.id} item={item} />)}
        </View>
      ) : (
        <View style={{ borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, padding: 16, gap: 4 }}>
          <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 16, color: c.text }}>No events yet</Text>
          <Text style={{ fontSize: 14, lineHeight: 20, color: c.textMuted }}>
            Upcoming events from Explore will appear here as they are added.
          </Text>
        </View>
      )}
    </SectionHeader>
  ) : null

  // ── Wide desktop: a real two-column composition ─────────────────────────
  // A centered ~1040px container with the schedule (Up Next + This Week) as
  // the primary column and a ~320px right rail for the member's center, the
  // welcome tour, and board activity — so the page uses the width instead of
  // stranding a narrow column in empty gray. Reuses the exact same section
  // blocks as mobile; only their arrangement differs.
  if (isWideDesktop) {
    if (isLoggedOutWeb) {
      return (
        <>
          <ScrollView
            style={{ flex: 1, backgroundColor: c.bg }}
            contentContainerStyle={desktopScrollContent}
            showsVerticalScrollIndicator={false}
          >
            <DesktopColumns
              main={<HomeGhostPreview c={c} />}
              rail={guestSetupRail}
            />
          </ScrollView>
          {authPrompt}
        </>
      )
    }

    // Members keep first-run overview / boards in the rail.
    const rail = isNewUser ? firstRunOverview : (
      <View style={{ gap: 22 }}>{boardsSection}</View>
    )
    return (
      <>
        <ScrollView
          style={{ flex: 1, backgroundColor: c.bg }}
          contentContainerStyle={desktopScrollContent}
          showsVerticalScrollIndicator={false}
        >
          <DesktopColumns
            header={
              <>
                {greeting}
                {adminShortcut}
                {welcomeBanner}
              </>
            }
            main={
              <>
                {upNextSection}
                {weekSection}
              </>
            }
            rail={rail}
          />
        </ScrollView>
        {authPrompt}
      </>
    )
  }

  if (isLoggedOutWeb) {
    return (
      <>
        <ScrollView
          style={{ flex: 1, backgroundColor: c.bg }}
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 20,
            paddingBottom: 40,
          }}
          showsVerticalScrollIndicator={false}
        >
          <View style={{ width: '100%', maxWidth: 640, alignSelf: 'center' }}>
            {guestSetupRail}
          </View>
        </ScrollView>
        {authPrompt}
      </>
    )
  }

  // ── Mobile web + native + narrow web: original single centered column ────
  return (
    <>
      <ScrollView
        style={{ flex: 1, backgroundColor: c.bg }}
        contentContainerStyle={{
          paddingHorizontal: isDesktop ? 24 : 16,
          paddingTop: Platform.OS === 'web' ? 20 : 8,
          paddingBottom: Platform.OS === 'web' ? 40 : 112,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Mobile single column: lead with the schedule (the desktop "main"
            column — Up Next + Coming Up), then wrap the center/boards content
            (the desktop right rail) below it, so the order matches desktop. */}
        <View style={{ width: '100%', maxWidth: 640, alignSelf: 'center', gap: 22 }}>
          {greeting}
          {adminShortcut}
          {welcomeBanner}
          {upNextSection}
          {weekSection}
          {firstRunOverview}
          {boardsSection}
          {/* Guest callout sits below the live content (new-30): events sell
              the app, the callout just names the next step. */}
          {guestNudge}
        </View>
      </ScrollView>
      {authPrompt}
    </>
  )
}

// One tight welcome line (orient + Explore) instead of a 3-row feature tour —
// the real content (Your Center, Up Next, Coming Up) already shows what the app
// does, so a single orienting sentence + Explore CTA is enough. Rendered as a
// full-width top row on desktop and inline at the top of the column on mobile.
function WelcomeBanner({ c, onExplore, centerName }: { c: AppColors; onExplore: () => void; centerName?: string }) {
  const cardBase = { borderRadius: 18, borderWidth: 1, borderColor: c.border, backgroundColor: c.card } as const
  // Login/role-state personalization: a member who's already joined a center
  // isn't "new" — greet them by their center and nudge toward RSVPing, rather
  // than the generic "Welcome to Janata" shown to first-touch/no-center users.
  const title = centerName ? `You're in at ${centerName}` : 'Welcome to Janata'
  const subtitle = centerName
    ? 'RSVP to your first event, then say hello on your center board.'
    : 'Find satsangs, camps, and classes near you.'
  return (
    <View style={[cardBase, { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16 }]}>
      <View style={{ width: 44, height: 44, borderRadius: 13, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Compass size={21} color={c.accent} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 16, color: c.text }}>
          {title}
        </Text>
        <Text style={{ fontSize: 13.5, lineHeight: 19, color: c.textMuted }}>
          {subtitle}
        </Text>
      </View>
      <Pressable
        onPress={onExplore}
        accessibilityRole="button"
        accessibilityLabel="Explore events"
        style={{ paddingVertical: 9, paddingHorizontal: 16, borderRadius: 999, backgroundColor: c.accent }}
      >
        <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 13.5, color: c.textInverse }}>Explore</Text>
      </Pressable>
    </View>
  )
}

function GhostBlock({
  c,
  width,
  height,
  opacity = 1,
}: {
  c: AppColors
  width: number | string
  height: number
  opacity?: number
}) {
  return (
    <View
      style={{
        width: width as any,
        height,
        opacity,
        borderRadius: height / 2,
        backgroundColor: c.panel,
      }}
    />
  )
}

function HomeGhostPreview({ c }: { c: AppColors }) {
  const rowOpacities = [0.58, 0.38, 0.22]
  return (
    <View style={{ gap: 14 }} pointerEvents="none">
      <View
        style={{
          borderRadius: 22,
          borderWidth: 1,
          borderColor: c.border,
          backgroundColor: c.card,
          overflow: 'hidden',
          opacity: 0.72,
        }}
      >
        <View style={{ height: 124, backgroundColor: c.panel }} />
        <View style={{ padding: 16, gap: 12 }}>
          <GhostBlock c={c} width={84} height={18} />
          <View style={{ gap: 8 }}>
            <GhostBlock c={c} width="70%" height={18} />
            <GhostBlock c={c} width="46%" height={13} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flexDirection: 'row' }}>
              {Array.from({ length: 4 }).map((_, index) => (
                <View
                  key={index}
                  style={{
                    width: 24,
                    height: 24,
                    marginLeft: index === 0 ? 0 : -7,
                    borderRadius: 12,
                    borderWidth: 2,
                    borderColor: c.card,
                    backgroundColor: c.panel,
                  }}
                />
              ))}
            </View>
            <GhostBlock c={c} width={88} height={16} />
          </View>
        </View>
      </View>

      <View style={{ gap: 10 }}>
        {rowOpacities.map((opacity, index) => (
          <View
            key={index}
            style={{
              opacity,
              flexDirection: 'row',
              gap: 12,
              padding: 12,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: c.border,
              backgroundColor: c.card,
            }}
          >
            <View
              style={{
                width: 44,
                height: 50,
                borderRadius: 10,
                backgroundColor: c.surface,
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
              }}
            >
              <GhostBlock c={c} width={22} height={7} />
              <GhostBlock c={c} width={18} height={14} />
            </View>
            <View style={{ flex: 1, minWidth: 0, justifyContent: 'center', gap: 8 }}>
              <GhostBlock c={c} width={index === 1 ? '58%' : '74%'} height={14} />
              <GhostBlock c={c} width={index === 2 ? '42%' : '52%'} height={11} />
            </View>
          </View>
        ))}
      </View>
    </View>
  )
}

// First-run overview shown to members who haven't engaged yet: a card for their
// center (or a prompt to pick one) and a peek at their board feed when there's
// activity. The greeting, WelcomeBanner, and the real Up Next / Coming Up
// sections render around it, so Home leads with useful content.
function FirstRunOverview({
  c,
  detailColors,
  center,
  peek,
  onFeed,
  onChooseCenter,
  onOpenCenter,
  onPeekPress,
}: {
  c: AppColors
  detailColors: ReturnType<typeof useDetailColors>
  center?: DiscoverCenter
  peek: BoardMessage[]
  onFeed: () => void
  onChooseCenter: () => void
  onOpenCenter: (id: string) => void
  onPeekPress: (id: string) => void
}) {
  const eyebrow = { fontSize: 11, letterSpacing: 0.9, color: c.textFaint, paddingHorizontal: 4 } as const
  const cardBase = { borderRadius: 18, borderWidth: 1, borderColor: c.border, backgroundColor: c.card } as const
  const cityState = center?.address ? extractCityState(center.address) : undefined
  const centerMeta = [cityState, center?.memberCount ? `${center.memberCount} members` : null].filter(Boolean).join(' · ')

  return (
    <View style={{ gap: 22 }}>
      <View style={{ gap: 10 }}>
        <Text style={eyebrow}>{center ? 'YOUR CENTER' : 'GET CONNECTED'}</Text>
        {center ? (
          <Pressable
            onPress={() => onOpenCenter(center.id)}
            accessibilityRole="button"
            accessibilityLabel={`Open ${center.name}`}
            style={[cardBase, { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16 }]}
          >
            <View style={{ width: 44, height: 44, borderRadius: 13, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
              <MapPin size={21} color={c.accent} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 16, color: c.text }} numberOfLines={1}>
                {center.name}
              </Text>
              {centerMeta ? (
                <Text style={{ fontSize: 13, color: c.textMuted }} numberOfLines={1}>
                  {centerMeta}
                </Text>
              ) : null}
            </View>
            <ChevronRight size={18} color={c.textFaint} />
          </Pressable>
        ) : (
          <Pressable
            onPress={onChooseCenter}
            accessibilityRole="button"
            accessibilityLabel="Choose your center"
            style={[cardBase, { padding: 16, gap: 8 }]}
          >
            <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 16, color: c.text }}>Choose your home center</Text>
            <Text style={{ fontSize: 14, lineHeight: 20, color: c.textMuted }}>
              Pick your center to follow its board and see its upcoming events.
            </Text>
            <Text style={{ fontSize: 13.5, color: c.accent }}>Choose your center →</Text>
          </Pressable>
        )}
      </View>

      {peek.length > 0 ? (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4 }}>
            <Text style={{ fontSize: 11, letterSpacing: 0.9, color: c.textFaint }}>LATEST ON YOUR BOARD</Text>
            <Pressable onPress={onFeed} hitSlop={8}>
              <Text style={{ fontWeight: '500', fontSize: 13, color: c.accent }}>Open Feed</Text>
            </Pressable>
          </View>
          <View>
            {peek.map((message) => (
              <BoardPostCard
                key={message.id}
                message={message}
                colors={detailColors}
                showSource
                onPress={() => onPeekPress(message.id)}
              />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  )
}

function SectionHeader({
  eyebrow,
  trailing,
  accentColor,
  faintColor,
  onTrailingPress,
  children,
}: {
  eyebrow: string
  trailing?: string
  accentColor: string
  faintColor: string
  onTrailingPress?: () => void
  children: React.ReactNode
}) {
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4 }}>
        <Text style={{ fontSize: 11, letterSpacing: 0.9, color: faintColor }}>{eyebrow}</Text>
        {trailing && (
          <Pressable onPress={onTrailingPress} hitSlop={8}>
            <Text style={{ fontWeight: '500', fontSize: 13, color: accentColor }}>{trailing}</Text>
          </Pressable>
        )}
      </View>
      {children}
    </View>
  )
}

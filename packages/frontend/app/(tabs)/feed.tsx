import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from 'react-native'
import { useFocusEffect, useNavigation, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAnalytics } from '../../utils/analytics'
import { supportsNativeDriver } from '../../utils/animation'
import { useUser } from '../../components/contexts'
import { useColors } from '../../hooks/useColors'
import { toThreadColors } from '../../tokens'
import { useHeaderAction } from '../../components/contexts/HeaderActionContext'
import { useCenterList, useMyEvents } from '../../hooks/useApiData'
import { extractCityState } from '../../utils/addressParsing'
import { CreatePostSheet, boardPostToMessage, type BoardMessage } from '../../components/boards'
import AuthPromptModal from '../../components/ui/AuthPromptModal'
import { centerPickerStore } from '../../utils/centerPickerStore'
import { createBoardPost, createPublicPost, fetchAggregatedFeed, fetchBoard } from '../../utils/api'
import {
  FeedHeader,
  NativeChatHeader,
  FeedWorkspace,
  FeedEmptyState,
  GhostPostCard,
  PostThread,
  type GroupBoard,
} from '../../components/feed'
import { buildFeedPosts } from '../../components/feed/feedData'
import {
  DESKTOP_MAX_WIDTH,
  DESKTOP_PAGE_BOTTOM,
  DESKTOP_PAGE_PADDING,
  DESKTOP_PAGE_TOP,
  useDesktopLayout,
} from '../../components/layout/DesktopColumns'
import type { DiscoverCenter, EventDisplay } from '../../utils/api'

function formatEventDateLabel(date: string) {
  const parsed = new Date(`${date}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return 'EVENT'
  return parsed
    .toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })
    .toUpperCase()
}

function sortUpcomingEvents(events: EventDisplay[]) {
  const today = new Date().toISOString().split('T')[0]
  return [...events]
    .filter((event) => !event.date || event.date >= today)
    .sort((a, b) => {
      if (!a.date && !b.date) return 0
      if (!a.date) return 1
      if (!b.date) return -1
      return a.date.localeCompare(b.date)
    })
}

function haversineMiles(
  from?: { latitude?: number | null; longitude?: number | null } | null,
  to?: { latitude?: number | null; longitude?: number | null } | null
) {
  if (
    !from ||
    !to ||
    !Number.isFinite(from.latitude) ||
    !Number.isFinite(from.longitude) ||
    !Number.isFinite(to.latitude) ||
    !Number.isFinite(to.longitude)
  ) {
    return undefined
  }
  const toRad = (value: number) => (value * Math.PI) / 180
  const lat1 = toRad(from.latitude!)
  const lat2 = toRad(to.latitude!)
  const dLat = toRad(to.latitude! - from.latitude!)
  const dLng = toRad(to.longitude! - from.longitude!)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function formatDistance(distanceMi?: number) {
  if (distanceMi == null || !Number.isFinite(distanceMi)) return undefined
  if (distanceMi < 0.5) return 'Nearby'
  if (distanceMi < 10) return `${distanceMi.toFixed(1)} mi`
  return `${Math.round(distanceMi)} mi`
}

// "Nearby" already reads as a place, so it never takes " away" — only numeric
// distances do ("2.3 mi away"). Avoids the "Nearby away" subtitle bug.
function distancePhrase(distanceLabel?: string) {
  if (!distanceLabel) return null
  return distanceLabel === 'Nearby' ? 'Nearby' : `${distanceLabel} away`
}

function centerToGroup(center: DiscoverCenter, distanceMi?: number): GroupBoard {
  const distanceLabel = formatDistance(distanceMi)
  const locationLabel = extractCityState(center.address) || center.address || 'Center board'
  return {
    id: `center-${center.id}`,
    kind: 'center',
    title: center.name,
    eyebrow: 'Center board',
    subtitle: [locationLabel, distancePhrase(distanceLabel)].filter(Boolean).join(' · '),
    meta: 'No posts yet',
    preview: 'No posts yet. Be the first to share something on your boards.',
    unreadCount: 0,
    messages: [],
    parentId: center.id,
    distanceMi,
    routeHref: `/center/${center.id}`,
  }
}

function eventToGroup(event: EventDisplay, fallbackCenterName?: string, distanceMi?: number): GroupBoard {
  const distanceLabel = formatDistance(distanceMi)
  return {
    id: `event-${event.id}`,
    kind: 'event',
    title: event.title,
    eyebrow: formatEventDateLabel(event.date),
    subtitle: `${fallbackCenterName || event.location || 'Event board'} · ${event.attendees || 0} going`,
    meta: distancePhrase(distanceLabel) || 'No posts yet',
    preview: 'No posts yet. Be the first to share something on your boards.',
    unreadCount: 0,
    messages: [],
    parentId: event.id,
    distanceMi,
    routeHref: `/events/${event.id}`,
  }
}

function publicToGroup(messages: BoardMessage[]): GroupBoard {
  return {
    id: 'public',
    kind: 'public',
    title: 'Public',
    eyebrow: 'Public',
    subtitle: 'Visible to all signed-in members',
    meta: messages.length ? `${messages.length} posts` : 'No posts yet',
    preview: 'Share updates, requests, and reflections with Janata.',
    unreadCount: 0,
    messages,
    parentId: 'public',
  }
}

function sortGroupsByDistance(groups: GroupBoard[]) {
  return [...groups].sort((a, b) => {
    const aDistance = a.distanceMi ?? Number.POSITIVE_INFINITY
    const bDistance = b.distanceMi ?? Number.POSITIVE_INFINITY
    if (aDistance !== bDistance) return aDistance - bDistance
    if (a.kind !== b.kind) return a.kind === 'center' ? -1 : 1
    return a.title.localeCompare(b.title)
  })
}

function matchesQuery(value: string, query: string) {
  return value.toLowerCase().includes(query.toLowerCase().trim())
}

export default function FeedScreen() {
  const router = useRouter()
  const navigation = useNavigation()
  const { user, updateProfile } = useUser()
  const colors = useColors()
  const { width } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const { track } = useAnalytics()
  const detailTranslateX = useRef(new Animated.Value(width)).current
  const {
    events: myEvents,
    loading: myEventsLoading,
    refetch: refetchMyEvents,
  } = useMyEvents(user?.username)
  const { centers: allCenters, loading: centersLoading, refetch: refetchCenters } = useCenterList()

  const isDesktop = useDesktopLayout(width)
  const [query, setQuery] = useState('')
  const [selectedPostId, setSelectedPostId] = useState('')
  const [createPostOpen, setCreatePostOpen] = useState(false)
  const [authPromptOpen, setAuthPromptOpen] = useState(false)
  const [boardMessagesByGroup, setBoardMessagesByGroup] = useState<Record<string, BoardMessage[]>>({})
  const [boardsLoading, setBoardsLoading] = useState(false)
  const { setCreateHandler } = useHeaderAction()

  useFocusEffect(
    useCallback(() => {
      refetchMyEvents()
      refetchCenters()
    }, [refetchMyEvents, refetchCenters])
  )

  // Only offer the compose (+) action to signed-in members — a guest has no
  // boards to post to, so the affordance sat above the sign-in wall doing nothing.
  useEffect(() => {
    if (!user) { setCreateHandler(null); return }
    setCreateHandler(() => setCreatePostOpen(true))
    return () => setCreateHandler(null)
  }, [setCreateHandler, user])

  const threadColors = toThreadColors(colors)

  const canAccessBoards = !!user
  const userCenter = allCenters.find((item) => item.id === user?.centerID)

  useEffect(() => {
    if (!user || !centerPickerStore.result) return

    const centerId = centerPickerStore.result
    centerPickerStore.result = null
    updateProfile({ centerID: centerId })
      .then((result) => {
        if (result.success) {
          track('feed_setup_center_joined', { center_id: centerId, source: 'feed_empty_auth_return' })
          refetchCenters()
        } else {
          track('feed_setup_center_join_failed', { center_id: centerId, source: 'feed_empty_auth_return' })
        }
      })
      .catch(() => {
        track('feed_setup_center_join_failed', { center_id: centerId, source: 'feed_empty_auth_return' })
      })
  }, [user, updateProfile, track, refetchCenters])

  const groups = useMemo<GroupBoard[]>(() => {
    const nextGroups: GroupBoard[] = []

    if (user && userCenter) {
      nextGroups.push(centerToGroup(userCenter, 0))
    }

    const registeredEvents = sortUpcomingEvents(myEvents)
    const liveEventGroups =
      user
        ? registeredEvents.map((event) => {
            const eventDistance = haversineMiles(userCenter, {
              latitude: event.latitude,
              longitude: event.longitude,
            })
            const centerName = allCenters.find((item) => item.id === event.centerId)?.name
            return eventToGroup(event, centerName, eventDistance)
          })
        : []

    nextGroups.push(...liveEventGroups)

    return sortGroupsByDistance(nextGroups)
  }, [allCenters, myEvents, user, userCenter])

  const groupBoardKey = useMemo(
    () => groups.map((group) => `${group.id}:${group.kind}:${group.parentId}`).join('|'),
    [groups]
  )

  const loadBoards = useCallback(async () => {
    if (!canAccessBoards) {
      setBoardMessagesByGroup({})
      setBoardsLoading(false)
      return
    }

    setBoardsLoading(true)
    try {
      const boardGroups = groups.filter(
        (group): group is GroupBoard & { kind: 'center' | 'event' } => group.kind !== 'public'
      )
      const [entries, aggregatePosts] = await Promise.all([
        Promise.all(
          boardGroups.map(async (group) => {
            const data = await fetchBoard(group.kind, group.parentId)
            return [group.id, data.posts.map(boardPostToMessage)] as const
          })
        ),
        fetchAggregatedFeed({ limit: 100 }),
      ])
      const publicMessages = aggregatePosts
        .filter((post) => post.boardId === null || post.visibility === 'public_signed_in')
        .map(boardPostToMessage)
      setBoardMessagesByGroup({
        ...Object.fromEntries(entries),
        public: publicMessages,
      })
    } finally {
      setBoardsLoading(false)
    }
  }, [canAccessBoards, groupBoardKey])

  useEffect(() => {
    loadBoards()
  }, [loadBoards])

  const groupsWithMessages = useMemo<GroupBoard[]>(
    () => {
      const boardGroups = groups.map((group) => ({
        ...group,
        messages: boardMessagesByGroup[group.id] ?? [],
      }))
      return user
        ? [publicToGroup(boardMessagesByGroup.public ?? []), ...boardGroups]
        : boardGroups
    },
    [boardMessagesByGroup, groups, user]
  )

  const feedPosts = useMemo(() => buildFeedPosts(groupsWithMessages), [groupsWithMessages])

  const filteredFeedPosts = useMemo(() => {
    if (!query.trim()) return feedPosts
    return feedPosts.filter(
      (post) =>
        matchesQuery(post.body, query) ||
        matchesQuery(post.author.name, query) ||
        matchesQuery(post.sourceTitle, query)
    )
  }, [feedPosts, query])

  // No implicit default: the desktop feed shows the post stream until the user
  // explicitly opens a post (in-place swap to the thread). Only resolve a
  // selected post when there is a real selection.
  const selectedPost = selectedPostId
    ? feedPosts.find((post) => post.id === selectedPostId)
    : undefined
  const mobilePostOpen = !isDesktop && !!selectedPostId
  const nativeDetailOpen = Platform.OS !== 'web' && mobilePostOpen
  const listTopPadding = Platform.OS === 'web' ? 20 : 8
  const isLoading = user ? myEventsLoading || centersLoading || boardsLoading : false
  // Guests, and signed-in members with nothing in the feed yet (and no active
  // search), get the state-aware ghost empty state instead of the post stream.
  const showEmptyState = !user || (filteredFeedPosts.length === 0 && !query.trim())
  const hideMobileFeedHeader = !isDesktop && !user && showEmptyState
  const nativeTabBarStyle = {
    backgroundColor: colors.surface,
    borderTopColor: colors.border,
    height: 84,
    paddingTop: 8,
    paddingBottom: 18,
  }

  useEffect(() => {
    if (Platform.OS === 'web') return

    navigation.setOptions({
      tabBarStyle: nativeDetailOpen ? { display: 'none' } : nativeTabBarStyle,
      // Hide the "Feed" tab header while a post is open so the detail's own
      // back/title bar becomes the screen header — no gap, no doubled header.
      headerShown: !nativeDetailOpen,
    })

    return () => {
      navigation.setOptions({ tabBarStyle: nativeTabBarStyle, headerShown: true })
    }
  }, [navigation, nativeDetailOpen, nativeTabBarStyle])

  useEffect(() => {
    if (Platform.OS === 'web') return

    if (!nativeDetailOpen) {
      detailTranslateX.setValue(width)
      return
    }

    Animated.timing(detailTranslateX, {
      toValue: 0,
      duration: 280,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: supportsNativeDriver,
    }).start()
  }, [detailTranslateX, nativeDetailOpen, width])

  const primeNativeDetailTransition = () => {
    if (Platform.OS !== 'web' && !isDesktop) {
      detailTranslateX.stopAnimation()
      detailTranslateX.setValue(width)
    }
  }

  const clearDetailSelection = () => {
    setSelectedPostId('')
  }

  // Track non-empty search queries with a short debounce so rapid keystrokes
  // are collapsed into a single event.
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    if (!query.trim()) return
    searchDebounceRef.current = setTimeout(() => {
      track('feed_searched', { query: query.trim(), source: 'feed' })
    }, 600)
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    }
  }, [query])

  const handleSignIn = useCallback(() => {
    track('connect_signin_pressed', { source: 'feed_setup' })
    setAuthPromptOpen(true)
  }, [track])

  const handleBrowseEvents = useCallback(() => {
    track('connect_explore_pressed', { source: 'feed_setup' })
    router.push('/explore' as never)
  }, [router, track])

  // Hard-gate path (new-15): the not-yet-invited paste an invite link/code.
  // /join validates it; #403's Door 1 takes over post-#440.
  const handlePasteInvite = useCallback(() => {
    track('feed_paste_invite_pressed', { source: 'feed_setup' })
    router.push('/join' as never)
  }, [router, track])

  // Inline "join your center" from the empty-state rail. A guest can't persist a
  // center yet, so we stash the pick and route to auth (it survives sign-in via
  // centerPickerStore). A signed-in member joins immediately via updateProfile,
  // which optimistically updates user.centerID and reflows the feed.
  const handleJoinCenter = useCallback(
    async (centerId: string): Promise<boolean> => {
      if (!user) {
        centerPickerStore.result = centerId
        track('feed_setup_center_pick_guest', { center_id: centerId, source: 'feed_empty' })
        setAuthPromptOpen(true)
        return false
      }
      const result = await updateProfile({ centerID: centerId })
      if (result.success) {
        track('feed_setup_center_joined', { center_id: centerId, source: 'feed_empty' })
        refetchCenters()
        return true
      }
      track('feed_setup_center_join_failed', { center_id: centerId, source: 'feed_empty' })
      return false
    },
    [user, updateProfile, track, refetchCenters]
  )

  const closeDetail = () => {
    track('feed_post_detail_closed', { postId: selectedPostId, source: 'feed' })
    if (Platform.OS !== 'web' && nativeDetailOpen) {
      detailTranslateX.stopAnimation()
      Animated.timing(detailTranslateX, {
        toValue: width,
        duration: 230,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: supportsNativeDriver,
      }).start(({ finished }) => {
        if (finished) {
          clearDetailSelection()
        }
      })
      return
    }
    clearDetailSelection()
  }

  const openPost = (id: string) => {
    track('connect_feed_post_selected', { postId: id, source: 'feed' })
    primeNativeDetailTransition()
    setSelectedPostId(id)
  }

  const openAuthorProfile = (authorId: string) => {
    if (!authorId || authorId === user?.id) return
    track('feed_author_profile_pressed', { author_id: authorId, source: 'feed' })
    router.push(`/members/${encodeURIComponent(authorId)}` as never)
  }

  const openGroup = (group: GroupBoard) => {
    if (!group.routeHref) return
    track('connect_empty_board_opened', { groupId: group.id, kind: group.kind, source: 'feed' })
    router.push(group.routeHref as never)
  }

  const handleCreatePost = async (
    group: { kind: 'center' | 'event' | 'public'; parentId: string },
    body: string,
    imageUrl?: string | null
  ) => {
    // Post create/fail analytics live in CreatePostSheet (the only caller of
    // this handler) so a single post fires ONE content_created / board_post_*
    // event, not a duplicate pair. Just do the work and let errors propagate.
    if (group.kind === 'public') {
      await createPublicPost(body, imageUrl)
    } else {
      await createBoardPost(group.kind, group.parentId, body, imageUrl)
    }
    await loadBoards()
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{
          width: '100%',
          maxWidth: isDesktop ? DESKTOP_MAX_WIDTH : 640,
          alignSelf: 'center',
          paddingHorizontal: isDesktop ? DESKTOP_PAGE_PADDING : 16,
          paddingTop: isDesktop ? DESKTOP_PAGE_TOP : listTopPadding,
          paddingBottom: isDesktop ? DESKTOP_PAGE_BOTTOM : Platform.OS === 'web' ? 40 : 112,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Desktop moves search into the right context rail (Twitter-style),
            so only render the full-width search header on mobile/narrow web. */}
        {!isDesktop && !hideMobileFeedHeader ? (
          <FeedHeader
            query={query}
            colors={colors}
            mobileInDetail={mobilePostOpen && !nativeDetailOpen}
            onBack={closeDetail}
            onChangeQuery={setQuery}
          />
        ) : null}

        {isLoading ? (
          <View style={{ gap: 12, paddingTop: 8 }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <GhostPostCard key={i} colors={colors} />
            ))}
          </View>
        ) : showEmptyState ? (
          <FeedEmptyState
            colors={colors}
            isDesktop={isDesktop}
            isSignedIn={!!user}
            groups={groupsWithMessages}
            query={query}
            centerName={userCenter?.name}
            onChangeQuery={setQuery}
            onSignIn={handleSignIn}
            onJoinCenter={handleJoinCenter}
            onBrowseEvents={handleBrowseEvents}
            onPasteInvite={handlePasteInvite}
            onCompose={() => {
              track('feed_compose_pressed', { source: 'feed_empty_panel' })
              setCreatePostOpen(true)
            }}
            onOpenGroup={openGroup}
          />
        ) : (
          <FeedWorkspace
            posts={filteredFeedPosts}
            selectedPost={selectedPost}
            colors={colors}
            threadColors={threadColors}
            isDesktop={isDesktop}
            hasQuery={query.trim().length > 0}
            query={query}
            onChangeQuery={setQuery}
            onBack={closeDetail}
            nativeDetailOpen={nativeDetailOpen}
            mobilePostOpen={mobilePostOpen}
            onOpenGroup={openGroup}
            onSelectPost={openPost}
            onAuthorPress={openAuthorProfile}
            onCompose={() => {
              track('feed_compose_pressed', { source: 'feed_empty_panel' })
              setCreatePostOpen(true)
            }}
            onPostChanged={loadBoards}
            onPostDeleted={() => {
              closeDetail()
              loadBoards()
            }}
            groups={groupsWithMessages}
          />
        )}
      </ScrollView>

      {nativeDetailOpen ? (
        <>
          {/* Static opaque backdrop. Hiding the "Feed" tab header reflows the
              feed list below; without this, the horizontal slide would expose
              that upward shift on the way in and out. The panel slides over a
              uniform surface instead. */}
          <View
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
              backgroundColor: colors.surface,
            }}
          />
          <Animated.View
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
              backgroundColor: colors.surface,
              transform: [{ translateX: detailTranslateX }],
            }}
          >
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              style={{ flex: 1, backgroundColor: colors.surface }}
            >
              <NativeChatHeader
                colors={colors}
                insetsTop={insets.top}
                title="Post"
                hideAvatar
                onBack={closeDetail}
              />
              <View style={{ flex: 1 }}>
                {selectedPost ? (
                  <PostThread
                    post={selectedPost}
                    colors={colors}
                    fullScreen
                    bottomInset={insets.bottom}
                    onAuthorPress={openAuthorProfile}
                    onPostChanged={loadBoards}
                    onPostDeleted={() => {
                      closeDetail()
                      loadBoards()
                    }}
                  />
                ) : null}
              </View>
            </KeyboardAvoidingView>
          </Animated.View>
        </>
      ) : null}

      <CreatePostSheet
        visible={createPostOpen}
        colors={colors}
        groups={groupsWithMessages}
        onClose={() => {
          track('feed_create_post_dismissed', { source: 'feed' })
          setCreatePostOpen(false)
        }}
        onSubmit={handleCreatePost}
      />

      <AuthPromptModal
        visible={authPromptOpen}
        onClose={() => setAuthPromptOpen(false)}
        returnTo="/feed"
        title="Join the conversation."
        subtitle="Janata is invite-only — members join through a friend's invite. Log in, or paste one to get in."
        bullets={[
          'Follow your center board and stay in the loop',
          'Join event boards after you RSVP',
          'Post updates, questions, and reflections with your sangha',
        ]}
      />
    </View>
  )
}

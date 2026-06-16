// Discover tab — mobile / native layout
import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { EmptyState } from '../../components/ui/EmptyState'
import { DiscoverListSkeleton } from '../../components/ui/Skeleton'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  Animated,
  PanResponder,
  StyleSheet,
  Image,
} from 'react-native'
import {
  MapPin,
  Search,
  Building2,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  Check,
  Globe,
  Plus,
} from 'lucide-react-native'
import { useRouter, useFocusEffect, useLocalSearchParams, useNavigation } from 'expo-router'
import { useAnalytics } from '../../utils/analytics'
import { useTheme } from '../../components/contexts'
import { Badge, Avatar, FilterChip } from '../../components/ui'
import { type FilterPickerOption } from '../../components/ui/FilterPickerModal'
import { useUser } from '../../components/contexts/UserContext'
import { useDiscoverData, type DiscoverFilter } from '../../hooks/useApiData'
import type { EventDisplay, DiscoverCenter, AttendeeInfo } from '../../utils/api'
import { extractCityState } from '../../utils/addressParsing'
import { isGoingFilterParam } from '../../components/explore/exploreShared'


// Map.native.tsx is the only file that bundles for native, so the
// react-native-maps deps would never have been lazy-skippable here.
// Lazy loading the chunk also crashes iOS in this monorepo setup:
// Metro resolves lazy-chunk URLs from the workspace root instead of
// packages/frontend/, returning 404 to the device and producing a
// "Could not load bundle" render error.
// See app/(tabs)/explore.web.tsx — web still lazy-loads Map there
// because Map.web.tsx pulls in maplibre-gl (~800KB) and the bug is
// Metro-specific.
import Map from '../../components/map/Map'

// Great-circle miles between two lat/lng points — used to rank the centers
// nearest to the member's home center.
function milesBetween(
  a: { latitude?: number; longitude?: number },
  b: { latitude?: number; longitude?: number }
): number {
  if (
    !Number.isFinite(a.latitude) || !Number.isFinite(a.longitude) ||
    !Number.isFinite(b.latitude) || !Number.isFinite(b.longitude)
  ) {
    return Number.POSITIVE_INFINITY
  }
  const toRad = (v: number) => (v * Math.PI) / 180
  const dLat = toRad(b.latitude! - a.latitude!)
  const dLng = toRad(b.longitude! - a.longitude!)
  const lat1 = toRad(a.latitude!)
  const lat2 = toRad(b.latitude!)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 3958.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}


/**
 * Format a date string into a short display like "FEB 26"
 */
function formatDatePill(dateStr: string): { month: string; day: string } {
  const d = new Date(dateStr + 'T00:00:00')
  if (isNaN(d.getTime())) return { month: '', day: '' }
  const month = d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()
  const day = String(d.getDate())
  return { month, day }
}

function isToday(dateStr: string): boolean {
  const today = new Date()
  return dateStr === today.toISOString().split('T')[0]
}

// ── Placeholder avatar dots for attendee count ──────────

const AVATAR_COLORS = ['#E8862A', '#78716C', '#A8A29E', '#D6D3D1']

function AttendeeAvatars({ count, attendees }: { count: number; attendees?: AttendeeInfo[] }) {
  if (count <= 0) return null
  const shown = Math.min(count, 4)

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
      <View style={{ flexDirection: 'row' }}>
        {attendees && attendees.length > 0 ? (
          attendees.slice(0, shown).map((attendee, i) => (
            <Avatar
              key={i}
              image={attendee.image}
              initials={attendee.initials}
              name={attendee.name}
              size={18}
              style={{
                marginLeft: i === 0 ? 0 : -6,
                borderWidth: 1.5,
                borderColor: 'white',
              }}
            />
          ))
        ) : (
          Array.from({ length: shown }).map((_, i) => (
            <View
              key={i}
              style={{
                width: 18,
                height: 18,
                borderRadius: 9,
                backgroundColor: AVATAR_COLORS[i % AVATAR_COLORS.length],
                marginLeft: i === 0 ? 0 : -6,
                borderWidth: 1.5,
                borderColor: 'white',
              }}
            />
          ))
        )}
      </View>
      <Text className="text-stone-400 dark:text-stone-500 font-sans text-xs">
        {count} going
      </Text>
    </View>
  )
}

// ─── Event Item ─────────────────────────────────────────

function EventItem({
  event,
  onPress,
  centerName,
}: {
  event: EventDisplay
  onPress: () => void
  centerName?: string
}) {
  const { month, day } = event.date ? formatDatePill(event.date) : { month: '', day: '' }
  const todayLabel = event.date ? isToday(event.date) : false

  return (
    <Pressable
      onPress={onPress}
      className={`flex-row gap-3 p-3 rounded-2xl active:opacity-70 ${
        event.isRegistered
          ? 'bg-orange-50 dark:bg-orange-950/20'
          : 'bg-white dark:bg-neutral-900'
      }`}
    >
      {/* Date pill */}
      <View className="w-12 h-14 rounded-xl items-center justify-center bg-stone-100 dark:bg-neutral-800">
        <Text className="text-[10px] font-sans" style={{ color: '#E8862A' }}>
          {month}
        </Text>
        <Text className="text-base font-sans text-content dark:text-content-dark">
          {day}
        </Text>
      </View>

      {/* Content */}
      <View className="flex-1 gap-0.5">
        <View className="flex-row items-center gap-1.5">
          <Text className="text-content dark:text-content-dark font-sans text-base leading-tight flex-1" numberOfLines={2}>
            {event.title}
          </Text>
          {event.isRegistered && <Badge label="Going" variant="going" />}
        </View>
        <Text className="text-stone-500 dark:text-stone-400 font-sans text-sm">
          {todayLabel ? 'Today · ' : ''}{event.time || ''}
        </Text>
        {centerName && (
          <Text className="text-stone-500 dark:text-stone-400 font-sans text-xs" numberOfLines={1}>
            By {centerName}
          </Text>
        )}
        <View className="flex-row items-center gap-1 mt-0.5">
          <MapPin size={12} color="#E8862A" />
          <Text className="text-stone-500 dark:text-stone-400 font-sans text-xs flex-1" numberOfLines={1}>
            {event.location}
          </Text>
        </View>
        {event.attendees > 0 && <AttendeeAvatars count={event.attendees} attendees={event.attendeesList} />}
      </View>

      {/* Hero thumbnail */}
      {event.image && (
        <Image
          source={{ uri: event.image }}
          style={{ width: 72, height: 72, borderRadius: 10 }}
          resizeMode="cover"
        />
      )}
    </Pressable>
  )
}

// ─── Center Item ────────────────────────────────────────

function CenterItem({ center, onPress, isMyCenter }: { center: DiscoverCenter; onPress: () => void; isMyCenter?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      className={`flex-row gap-3 p-3 rounded-2xl active:opacity-70 ${
        center.isMember || isMyCenter
          ? 'bg-orange-50 dark:bg-orange-950/20'
          : 'bg-white dark:bg-neutral-900'
      }`}
    >
      {/* Icon pill */}
      <View className="w-12 h-14 rounded-xl bg-orange-100 dark:bg-orange-900/30 items-center justify-center overflow-hidden">
        {center.image ? (
          <Image source={{ uri: center.image }} style={{ width: 48, height: 56 }} resizeMode="cover" />
        ) : (
          <Building2 size={20} color="#9A3412" />
        )}
      </View>

      {/* Content */}
      <View className="flex-1 gap-0.5">
        <View className="flex-row items-center gap-1.5">
          <Text className="text-content dark:text-content-dark font-sans text-base leading-tight flex-1" numberOfLines={1}>
            {center.name}
          </Text>
          {isMyCenter && <Badge label="My Center" variant="going" />}
          {!isMyCenter && center.isMember && <Badge label="Member" variant="member" />}
        </View>
        <Text className="text-stone-500 dark:text-stone-400 font-sans text-sm">
          {extractCityState(center.address) || 'Center'}{center.distanceMi != null ? ` · ${center.distanceMi} mi` : ''}
        </Text>
        {center.eventCount != null && center.eventCount > 0 && (
          <Text className="text-primary font-sans text-xs mt-0.5">
            {center.eventCount} events this week
          </Text>
        )}
      </View>
    </Pressable>
  )
}

// ─── Discover Screen ────────────────────────────────────

export default function DiscoverScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ going?: string }>()
  const { isDark } = useTheme()
  const { track } = useAnalytics()
  const [activeFilter, setActiveFilter] = useState<DiscoverFilter>('Events')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [showGoingOnly, setShowGoingOnly] = useState(false)
  const [showPastEvents, setShowPastEvents] = useState(false)
  const [selectedCenter, setSelectedCenter] = useState<string | null>(null)
  // The center dropdown opens an in-sheet list (not a modal) — view, pick one, or close.
  const [centerPickerOpen, setCenterPickerOpen] = useState(false)
  // Imperative map pan target — bumped when a center is picked so the map flies
  // to focus on it (parity with web Discover). zoom 10 ≈ the ~100mi area view.
  const [mapFlyTo, setMapFlyTo] = useState<{ latitude: number; longitude: number; key: number; zoom?: number } | null>(null)
    const { user } = useUser()
    const {
    items,
    filteredPoints,
    loading,
    allEvents,
    allCenters,
    refresh,
  } = useDiscoverData(activeFilter, searchQuery, user?.id, showPastEvents, showGoingOnly, user?.interests ?? undefined, user?.centerID, { fetchAttendees: true })

  useEffect(() => {
    setShowGoingOnly(isGoingFilterParam(params.going))
  }, [params.going])

  // The member's home center — pinned at the top of the sheet as their anchor.
  const userCenter = useMemo(
    () => allCenters.find((c) => c.id === user?.centerID),
    [allCenters, user?.centerID]
  )

  // The center whose area we're showing events for. The card is a dropdown:
  // selectedCenter overrides it; default is the member's home center. Events
  // are sorted by nearness to this center, so "pick a center → see what's on
  // around there."
  // "__all__" = show events from every center (no proximity scoping); null =
  // default to the member's home center; any id = that center's area.
  const isAllCenters = selectedCenter === '__all__'
  const areaCenterId = isAllCenters ? null : selectedCenter ?? user?.centerID ?? null
  const areaCenter = useMemo(
    () => (isAllCenters ? undefined : allCenters.find((c) => c.id === areaCenterId) ?? userCenter),
    [isAllCenters, allCenters, areaCenterId, userCenter]
  )
  const isHomeArea = !!areaCenter && areaCenter.id === user?.centerID
  // Users without a home center (or none selected) get the "All centers" view
  // so the filter still renders and they can pick a center from the picker.
  const showAllCenters = isAllCenters || !areaCenter

  useFocusEffect(
    useCallback(() => {
      refresh()
    }, [refresh])
  )

  // ── Sheet snap points ──────────────────────────────────
  // Four positions (as translateY values from the expanded state):
  //   expanded  = 0           → 100% sheet visible (full screen, header hidden)
  //   mid       = sheet * 0.2 → ~80% sheet visible (most content, map peeking)
  //   collapsed = sheet * 2/3 → ~33% sheet visible (peek + a few rows)
  //   peek      = sheet - 100 → just handle + search bar visible (100px)

  const EXPANDED_TOP = 60 // px from top of container when fully expanded

  const [containerHeight, setContainerHeight] = useState(0)
  const sheetHeight = containerHeight - EXPANDED_TOP // total sheet height

  const SNAP_EXPANDED = 0
  const SNAP_MID = Math.max(0, sheetHeight * 0.2)        // ~80% sheet visible
  const SNAP_COLLAPSED = Math.max(0, sheetHeight * (2 / 3))  // ~33% sheet visible
  const SNAP_PEEK = Math.max(0, sheetHeight - 100)       // 100px sheet visible (handle + search)

  const snapsRef = useRef({ expanded: SNAP_EXPANDED, mid: SNAP_MID, collapsed: SNAP_COLLAPSED, peek: SNAP_PEEK })
  snapsRef.current = { expanded: SNAP_EXPANDED, mid: SNAP_MID, collapsed: SNAP_COLLAPSED, peek: SNAP_PEEK }

  const sheetY = useRef(new Animated.Value(0)).current
  const offsetRef = useRef(0)
  const initializedRef = useRef(false)

  // Track expansion state for scroll behavior
  const [isSheetExpanded, setIsSheetExpanded] = useState(false)

  // Hide the nav header (with the profile-pic button) when the sheet is at
  // expanded snap so the sheet covers the full screen, including over where
  // the profile button sits. Restore when sheet leaves expanded.
  const navigation = useNavigation()
  React.useEffect(() => {
    navigation.setOptions({ headerShown: !isSheetExpanded })
  }, [navigation, isSheetExpanded])

  // Set initial sheet position to collapsed once we know the container height
  // (peek + a few rows visible, map prominent) — see SNAP_COLLAPSED.
  React.useEffect(() => {
    if (containerHeight > 0 && !initializedRef.current) {
      const collapsed = Math.max(0, (containerHeight - EXPANDED_TOP) * 0.6)
      sheetY.setValue(collapsed)
      offsetRef.current = collapsed
      initializedRef.current = true
    }
  }, [containerHeight, sheetY])

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dy) > 8,
      onPanResponderGrant: () => {},
      onPanResponderMove: (_, gs) => {
        const max = snapsRef.current.peek
        const next = Math.max(0, Math.min(max, offsetRef.current + gs.dy))
        sheetY.setValue(next)
      },
      onPanResponderRelease: (_, gs) => {
        const { expanded, mid, collapsed, peek } = snapsRef.current
        const current = Math.max(0, Math.min(peek, offsetRef.current + gs.dy))

        // Find nearest snap, biased by velocity
        let snapTo: number
        if (gs.vy > 1) {
          // Fast swipe down — jump one stop down from current
          if (offsetRef.current <= expanded + 10) snapTo = mid
          else if (offsetRef.current <= mid + 10) snapTo = collapsed
          else snapTo = peek
        } else if (gs.vy < -1) {
          // Fast swipe up — jump one stop up from current
          if (offsetRef.current >= peek - 10) snapTo = collapsed
          else if (offsetRef.current >= collapsed - 10) snapTo = mid
          else snapTo = expanded
        } else {
          // Position-based: snap to nearest of 4
          const dExp = Math.abs(current - expanded)
          const dMid = Math.abs(current - mid)
          const dCol = Math.abs(current - collapsed)
          const dPeek = Math.abs(current - peek)
          const minD = Math.min(dExp, dMid, dCol, dPeek)
          snapTo =
            minD === dExp ? expanded : minD === dMid ? mid : minD === dCol ? collapsed : peek
        }

        offsetRef.current = snapTo
        setIsSheetExpanded(snapTo === expanded)
        Animated.spring(sheetY, {
          toValue: snapTo,
          useNativeDriver: false,
          damping: 28,
          stiffness: 220,
          mass: 0.8,
        }).start()
      },
    })
  ).current

  // ── Data ──────────────────────────────────────────────
  const displayItems = React.useMemo(() => {
    let result = items
    if (selectedDate) {
      result = result.filter(
        (item) => item.type === 'event' && (item.data as EventDisplay).date === selectedDate
      )
    }
    // An explicit center pick filters events to that center + a ~100mi radius.
    // The default / home-center case below only sorts, so the list never starts empty.
    if (areaCenter && selectedCenter && !isAllCenters && result.every((i) => i.type === 'event')) {
      result = result.filter((item) => {
        const e = item.data as EventDisplay
        return e.centerId === areaCenter.id || milesBetween(areaCenter, e) <= 100
      })
    }
    // Order the events by nearness to the selected area center so "what's on
    // around <center>" surfaces first. Sorting (not filtering) keeps the list
    // from ever going empty. Only applies to a flat events list.
    if (areaCenter && result.length > 0 && result.every((i) => i.type === 'event')) {
      result = [...result].sort(
        (a, b) =>
          milesBetween(areaCenter, a.data as EventDisplay) -
          milesBetween(areaCenter, b.data as EventDisplay)
      )
    }
    return result
  }, [items, selectedDate, areaCenter, selectedCenter, isAllCenters])

  // Map markers honor the same explicit-center radius filter as the list.
  const mapPoints = useMemo(() => {
    if (!areaCenter || !selectedCenter || isAllCenters) return filteredPoints
    return filteredPoints.filter(
      (p) => p.id === areaCenter.id || milesBetween(areaCenter, p) <= 100
    )
  }, [filteredPoints, areaCenter, selectedCenter, isAllCenters])

  // Count of items under each section header (e.g. centers per state) so the
  // grouped list shows "CALIFORNIA  3" — counts the rows even while collapsed.
  const sectionCounts = React.useMemo(() => {
    const counts: Record<string, number> = {}
    let current: string | null = null
    for (const item of displayItems) {
      if (item.type === 'section') {
        current = item.data.label
        counts[current] = 0
      } else if (current) {
        counts[current] += 1
      }
    }
    return counts
  }, [displayItems])

  // Filter chip helpers — counts over upcoming events
  const todayStr = new Date().toISOString().split('T')[0]
  const eventsForCounts = useMemo(
    () => (showPastEvents ? allEvents : allEvents.filter((e) => !e.date || e.date >= todayStr)),
    [allEvents, showPastEvents, todayStr]
  )
  const centerOptions = useMemo<FilterPickerOption<string>[]>(() => {
    const counts: Record<string, number> = {}
    for (const e of eventsForCounts) {
      if (e.centerId) counts[e.centerId] = (counts[e.centerId] ?? 0) + 1
    }
    return [...allCenters]
      .map((c) => ({ value: c.id, label: c.name, sublabel: extractCityState(c.address) || c.address, count: counts[c.id] ?? 0 }))
      .sort((a, b) => {
        if (user?.centerID && a.value === user.centerID) return -1
        if (user?.centerID && b.value === user.centerID) return 1
        return a.label.localeCompare(b.label)
      })
  }, [allCenters, eventsForCounts, user?.centerID])

  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  const toggleSection = useCallback((label: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }, [])

  // Default Centers list to fully collapsed on first visit (90+ centers,
  // an all-expanded view is overwhelming).
  const collapsedInitFor = useRef<DiscoverFilter | null>(null)
  React.useEffect(() => {
    if (activeFilter !== 'Centers') {
      collapsedInitFor.current = null
      return
    }
    if (collapsedInitFor.current === 'Centers') return
    if (items.length === 0) return
    const labels = new Set<string>()
    let isFirst = true
    for (const item of items) {
      if (item.type === 'section') {
        if (!isFirst) labels.add(item.data.label)
        isFirst = false
      }
    }
    setCollapsedSections(labels)
    collapsedInitFor.current = 'Centers'
  }, [activeFilter, items])

  const stickyHeaderIndices = useMemo(
    () =>
      displayItems.reduce<number[]>((acc, item, idx) => {
        if (item.type === 'section') acc.push(idx)
        return acc
      }, []),
    [displayItems]
  )

  const handleFilterPress = (f: DiscoverFilter) => {
    track('discover_filter_changed', { filter: f, source: 'discover' })
    setActiveFilter(f)
    setSelectedDate(null)
  }

  const handlePointPress = (point: { id: string; type: 'center' | 'event' }) => {
    track('map_point_pressed', { type: point.type, id: point.id, source: 'discover' })
    if (point.type === 'center') {
      router.push(`/center/${point.id}`)
    } else {
      router.push(`/events/${point.id}`)
    }
  }

  // One center row in the picker (parity with web Discover). Centers WITH events
  // scope the list + fly the map to that area; centers WITHOUT events only open
  // the center page (no point scoping an area with nothing on).
  const renderCenterRow = (opt: FilterPickerOption<string>) => {
    const count = opt.count ?? 0
    const selectable = count > 0
    const openPage = () => {
      track('explore_center_page_opened', { centerId: opt.value })
      setCenterPickerOpen(false)
      router.push(`/center/${opt.value}`)
    }
    const scopeToCenter = () => {
      track('explore_area_center_selected', { centerId: opt.value })
      setSelectedCenter(opt.value)
      setCenterPickerOpen(false)
      setSearchQuery('')
      const c = allCenters.find((cc) => cc.id === opt.value)
      if (c && Number.isFinite(c.latitude) && Number.isFinite(c.longitude)) {
        setMapFlyTo((prev) => ({
          latitude: c.latitude as number,
          longitude: c.longitude as number,
          zoom: 10,
          key: (prev?.key ?? 0) + 1,
        }))
      }
    }
    return (
      <View key={opt.value}>
        <View className="bg-stone-200/70 dark:bg-neutral-800" style={{ height: 1, marginHorizontal: 16 }} />
        <View className="flex-row items-center px-4" style={{ minHeight: 56, gap: 8 }}>
          <Pressable
            onPress={selectable ? scopeToCenter : openPage}
            accessibilityRole="button"
            accessibilityLabel={selectable ? `Show events near ${opt.label}` : `View ${opt.label} page`}
            className="flex-1 flex-row items-center active:opacity-60"
            style={{ gap: 12, minHeight: 56 }}
          >
            <View
              className="w-10 h-10 rounded-xl items-center justify-center"
              style={{ backgroundColor: isDark ? 'rgba(232,134,42,0.18)' : '#FDE8D0' }}
            >
              <Building2 size={18} color="#E8862A" />
            </View>
            <View style={{ flex: 1 }}>
              <Text className="text-content dark:text-content-dark font-sans" style={{ fontSize: 15 }} numberOfLines={1}>
                {opt.label}
              </Text>
              <Text className="text-stone-500 dark:text-stone-400 font-sans" style={{ fontSize: 12.5 }} numberOfLines={1}>
                {opt.sublabel}
              </Text>
            </View>
          </Pressable>
          {selectable ? (
            <View className="rounded-full px-2.5 py-1" style={{ backgroundColor: isDark ? 'rgba(232,134,42,0.18)' : '#FDE8D0' }}>
              <Text className="font-sans" style={{ fontSize: 12, fontWeight: '600', color: '#E8862A' }}>
                {count} {count === 1 ? 'event' : 'events'}
              </Text>
            </View>
          ) : null}
          {opt.value === areaCenterId ? <Check size={18} color="#E8862A" /> : null}
          <Pressable
            onPress={openPage}
            accessibilityRole="button"
            accessibilityLabel={`View ${opt.label} page`}
            hitSlop={6}
            className="items-center justify-center active:opacity-60"
            style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: isDark ? '#262626' : '#F3F4F6' }}
          >
            <ChevronRight size={16} color={isDark ? '#A8A29E' : '#78716C'} />
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <View
      style={styles.container}
      onLayout={(e) => setContainerHeight(e.nativeEvent.layout.height)}
    >
      {/* Map — full bleed behind the sheet */}
      <View style={StyleSheet.absoluteFill}>
        <Map points={mapPoints} onPointPress={handlePointPress} userCenterID={user?.centerID} bottomPadding={90} flyTo={mapFlyTo} />
      </View>

      {/* Bottom Sheet — hidden until we measure the container */}
      {containerHeight > 0 && (
      <Animated.View
        style={[
          styles.sheet,
          { top: EXPANDED_TOP, transform: [{ translateY: sheetY }] },
        ]}
      >
        <View
          style={[
            styles.sheetInner,
            {
              backgroundColor: isDark ? '#171717' : '#fff',
              borderTopColor: isDark ? '#262626' : '#E5E7EB',
            },
          ]}
        >
          {/* ─── Draggable Header Zone ─── */}
          <View {...panResponder.panHandlers}>
            {/* Drag Handle */}
            <View style={styles.handleRow}>
              <View
                style={[
                  styles.handle,
                  { backgroundColor: isDark ? '#525252' : '#D1D5DB' },
                ]}
              />
            </View>

            {/* Search Input */}
            <View
              className="flex-row items-center mx-4 mb-3 px-3 rounded-xl"
              style={{
                minHeight: 44,
                backgroundColor: isDark ? '#262626' : '#F3F4F6',
              }}
            >
              <Search size={16} color="#9CA3AF" />
              <TextInput
                className="flex-1 ml-2 text-sm font-sans"
                style={{ color: isDark ? '#E5E7EB' : '#1F2937', paddingVertical: 8 }}
                placeholder="Search events and centers..."
                placeholderTextColor="#9CA3AF"
                value={searchQuery}
                onChangeText={setSearchQuery}
                onEndEditing={() => {
                  if (searchQuery.trim()) {
                    track('discover_search', { query: searchQuery.trim(), source: 'discover' })
                  }
                }}
              />
            </View>

            {/* Center dropdown — picks which center's area to show events for.
                Defaults to the member's home center; tapping opens the center
                list so they can see what's on around any center. */}
            {!centerPickerOpen && (isAllCenters || areaCenter || allCenters.length > 0) && (
              <Pressable
                onPress={() => {
                  track('explore_area_center_opened', { centerId: areaCenter?.id ?? 'all' })
                  setCenterPickerOpen(true)
                }}
                accessibilityRole="button"
                accessibilityLabel={
                  showAllCenters
                    ? 'Showing events from all centers. Tap to change.'
                    : `Showing events near ${areaCenter?.name}. Tap to change center.`
                }
                className="flex-row items-center mx-4 mb-3 px-3 rounded-2xl active:opacity-70"
                style={{
                  minHeight: 58,
                  gap: 12,
                  backgroundColor: isDark ? 'rgba(232,134,42,0.12)' : '#FFF7ED',
                  borderWidth: 1,
                  borderColor: isDark ? 'rgba(232,134,42,0.22)' : '#FDE8D0',
                }}
              >
                <View
                  className="w-10 h-10 rounded-xl items-center justify-center"
                  style={{ backgroundColor: isDark ? 'rgba(232,134,42,0.18)' : '#FDE8D0' }}
                >
                  {showAllCenters ? <Globe size={18} color="#E8862A" /> : <Building2 size={18} color="#E8862A" />}
                </View>
                <View style={{ flex: 1 }}>
                  <Text className="text-content dark:text-content-dark font-sans" style={{ fontSize: 15 }} numberOfLines={1}>
                    {showAllCenters ? 'All centers' : areaCenter?.name}
                  </Text>
                  <Text className="text-stone-500 dark:text-stone-400 font-sans" style={{ fontSize: 12.5 }} numberOfLines={1}>
                    {showAllCenters
                      ? 'Events everywhere · tap to change'
                      : isHomeArea
                        ? `Your center${areaCenter?.memberCount ? ` · ${areaCenter.memberCount} members` : ''}`
                        : 'Events near here · tap to change'}
                  </Text>
                </View>
                <ChevronDown size={18} color="#a8a29e" />
              </Pressable>
            )}

            {/* In-sheet center picker header — title + Close. The list itself
                renders in the ScrollView below. */}
            {centerPickerOpen && (
              <View
                className="flex-row items-center justify-between px-4"
                style={{ paddingTop: 2, paddingBottom: 8 }}
              >
                <Text className="font-sans text-stone-500 dark:text-stone-400 uppercase" style={{ fontSize: 11.5, letterSpacing: 0.9 }}>
                  Show events near
                </Text>
                <Pressable onPress={() => setCenterPickerOpen(false)} hitSlop={8}>
                  <Text style={{ fontSize: 13, fontWeight: '500', color: '#E8862A' }}>Close</Text>
                </Pressable>
              </View>
            )}

            {/* Filter chips — Today / Going + Create button */}
            {!centerPickerOpen && activeFilter === 'Events' && (
              <View className="flex-row items-center px-4 py-2 gap-2">
                <View className="flex-1 flex-row flex-wrap items-center gap-2">
                  <FilterChip
                    label="Today"
                    variant="outline"
                    active={selectedDate === todayStr}
                    onPress={() => {
                      setSelectedDate((prev) => {
                        const next = prev === todayStr ? null : todayStr
                        if (next) track('discover_date_selected', { date: next, source: 'discover' })
                        return next
                      })
                    }}
                  />
                  {user && (
                    <FilterChip
                      label="Going"
                      variant="outline"
                      active={showGoingOnly}
                      onPress={() => {
                        track('discover_going_filter_toggled', { enabled: !showGoingOnly, source: 'discover' })
                        setShowGoingOnly((prev) => !prev)
                      }}
                    />
                  )}
                </View>
                {user && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Create event"
                    hitSlop={8}
                    onPress={() => {
                      track('nav_create_event', { source: 'discover' })
                      router.push('/events/form')
                    }}
                    className="flex-row items-center active:opacity-70"
                    style={{
                      flexShrink: 0,
                      gap: 4,
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      borderRadius: 999,
                      borderWidth: 1.5,
                      borderColor: '#E8862A',
                    }}
                  >
                    <Plus size={16} color="#E8862A" strokeWidth={2.5} />
                    <Text style={{ fontWeight: '600', fontSize: 13, lineHeight: 18, color: '#E8862A' }}>
                      Create
                    </Text>
                  </Pressable>
                )}
              </View>
            )}
          </View>

          {/* Loading skeleton */}
          {loading && (
            <View style={{ paddingHorizontal: 16 }}>
              <DiscoverListSkeleton count={4} />
            </View>
          )}

          {/* Unified List */}
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 4, paddingTop: 12, paddingBottom: 40, gap: 4 }}
            showsVerticalScrollIndicator={false}
            scrollEnabled={true}
            stickyHeaderIndices={centerPickerOpen ? undefined : stickyHeaderIndices}
          >
            {centerPickerOpen && (
              <>
                {/* All centers — show events from every center, no area scoping. */}
                <Pressable
                  onPress={() => {
                    track('explore_area_all_selected')
                    setSelectedCenter('__all__')
                    setCenterPickerOpen(false)
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Show events from all centers"
                  className="flex-row items-center px-4 active:opacity-60"
                  style={{ minHeight: 56, gap: 12 }}
                >
                  <View
                    className="w-10 h-10 rounded-xl items-center justify-center"
                    style={{ backgroundColor: isDark ? 'rgba(232,134,42,0.18)' : '#FDE8D0' }}
                  >
                    <Globe size={18} color="#E8862A" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text className="text-content dark:text-content-dark font-sans" style={{ fontSize: 15 }} numberOfLines={1}>
                      All centers
                    </Text>
                    <Text className="text-stone-500 dark:text-stone-400 font-sans" style={{ fontSize: 12.5 }} numberOfLines={1}>
                      Events from every center
                    </Text>
                  </View>
                  {isAllCenters ? <Check size={18} color="#E8862A" /> : null}
                </Pressable>

                {(() => {
                  // Search filters the picker too; group centers with events
                  // (scopeable + fly) above the rest (page-only), like web.
                  const q = searchQuery.trim().toLowerCase()
                  const matches = q
                    ? centerOptions.filter((o) => o.label.toLowerCase().includes(q) || (o.sublabel ?? '').toLowerCase().includes(q))
                    : centerOptions
                  const withEvents = matches.filter((o) => (o.count ?? 0) > 0)
                  const withoutEvents = matches.filter((o) => (o.count ?? 0) === 0)
                  return (
                    <>
                      {withEvents.length > 0 && (
                        <Text className="font-sans text-stone-400 dark:text-stone-500 uppercase px-4 pt-3 pb-1" style={{ fontSize: 11, letterSpacing: 0.8 }}>
                          Centers with events
                        </Text>
                      )}
                      {withEvents.map(renderCenterRow)}
                      {withoutEvents.length > 0 && (
                        <Text className="font-sans text-stone-400 dark:text-stone-500 uppercase px-4 pt-5 pb-1" style={{ fontSize: 11, letterSpacing: 0.8 }}>
                          Other centers
                        </Text>
                      )}
                      {withoutEvents.map(renderCenterRow)}
                    </>
                  )
                })()}
              </>
            )}
            {!centerPickerOpen && !loading && displayItems.length === 0 && (
              <EmptyState variant={selectedDate ? 'date' : searchQuery ? 'search' : 'events'} />
            )}
            {!centerPickerOpen && displayItems.map((item, idx) => {
              if (item.type === 'section') {
                const label = item.data.label
                const isCollapsed = collapsedSections.has(label)
                const count = sectionCounts[label]
                return (
                  <Pressable
                    key={`section-${idx}`}
                    onPress={() => {
                      track('discover_section_toggled', { label, collapsed: !collapsedSections.has(label), source: 'discover' })
                      toggleSection(label)
                    }}
                    className="bg-white dark:bg-neutral-900 active:opacity-60"
                  >
                    {/* Inset hairline between states — softer than a full-bleed
                        line so the grouped list doesn't read as line-heavy. */}
                    {idx > 0 ? (
                      <View className="bg-stone-200/70 dark:bg-neutral-800" style={{ height: 1, marginHorizontal: 16 }} />
                    ) : null}
                    <View
                      style={{
                        paddingHorizontal: 16,
                        paddingTop: idx > 0 ? 18 : 8,
                        paddingBottom: 10,
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                        <Text className="font-sans text-stone-500 dark:text-stone-400 uppercase" style={{ fontSize: 11.5, letterSpacing: 0.9 }}>
                          {label}
                        </Text>
                        {count ? (
                          <Text className="font-sans text-stone-400 dark:text-stone-500" style={{ fontSize: 11.5 }}>
                            {count}
                          </Text>
                        ) : null}
                      </View>
                      {isCollapsed ? <ChevronDown size={16} color="#a8a29e" /> : <ChevronUp size={16} color="#a8a29e" />}
                    </View>
                  </Pressable>
                )
              }
              if (item.type === 'event') {
                return (
                  <EventItem
                    key={`event-${item.data.id}`}
                    event={item.data as EventDisplay}
                    centerName={allCenters.find((c) => c.id === (item.data as EventDisplay).centerId)?.name}
                    onPress={() => {
                      track('event_list_item_pressed', { eventId: item.data.id, source: 'discover' })
                      router.push(`/events/${item.data.id}`)
                    }}
                  />
                )
              }
              const sectionLabel = displayItems.slice(0, idx).reverse().find((i) => i.type === 'section')?.data?.label
              if (sectionLabel && collapsedSections.has(sectionLabel)) return null
              return (
                <CenterItem
                  key={`center-${item.data.id}`}
                  center={item.data as DiscoverCenter}
                  isMyCenter={!!user?.centerID && item.data.id === user.centerID}
                  onPress={() => {
                    track('center_list_item_pressed', { centerId: item.data.id, source: 'discover' })
                    router.push(`/center/${item.data.id}`)
                  }}
                />
              )
            })}
          </ScrollView>
        </View>
      </Animated.View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    // top is set dynamically via style prop
  },
  sheetInner: {
    flex: 1,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    overflow: 'hidden',
    // Shadow for visibility over the map
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 16,
  },
  handleRow: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 8,
  },
  handle: {
    width: 36,
    height: 5,
    borderRadius: 2.5,
  },
})

import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Building2, Check, ChevronDown, ChevronRight, Globe, Plus, Search } from 'lucide-react-native'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { EmptyState } from '../ui/EmptyState'
import { DiscoverListSkeleton } from '../ui/Skeleton'
import { FilterChip } from '../ui'
import type { FilterPickerOption } from '../ui/FilterPickerModal'
import { useTheme, useUser } from '../contexts'
import { useAnalytics } from '../../utils/analytics'
import { extractCityState } from '../../utils/addressParsing'
import { useDiscoverData, type DiscoverFilter } from '../../hooks/useApiData'
import type { EventDisplay, MapPoint } from '../../utils/api'
import { ExploreEventItem } from './ExploreEventItem.web'
import { isGoingFilterParam, milesBetween } from './exploreShared'

const Map = lazy(() => import('../map/Map'))

type SheetSnap = 'peek' | 'collapsed' | 'mid' | 'expanded'

export function MobileDiscoverFallback() {
  const router = useRouter()
  const params = useLocalSearchParams<{ going?: string }>()
  const { isDark } = useTheme()
  const { track } = useAnalytics()
  // Events-first: the mobile-web sheet always shows the events list. (The old
  // Events/Centers tab model was dropped to match native explore.tsx.)
  const activeFilter: DiscoverFilter = 'Events'
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [showGoingOnly, setShowGoingOnly] = useState(false)
  const [showPastEvents] = useState(false)
  const [selectedCenter, setSelectedCenter] = useState<string | null>(null)
  // The center dropdown opens an in-sheet list (not a modal) - view, pick one, or close.
  const [centerPickerOpen, setCenterPickerOpen] = useState(false)
  const [mapFlyTo, setMapFlyTo] = useState<{ latitude: number; longitude: number; key: number; zoom?: number } | null>(null)
  const { user } = useUser()
  const { items, filteredPoints, loading, allEvents, allCenters, refresh } = useDiscoverData(
    activeFilter,
    searchQuery,
    user?.id,
    showPastEvents,
    showGoingOnly,
    user?.interests ?? undefined,
    user?.centerID,
    { fetchAttendees: true }
  )

  useEffect(() => {
    setShowGoingOnly(isGoingFilterParam(params.going))
  }, [params.going])

  // The member's home center - anchors the dropdown's default area.
  const userCenter = useMemo(
    () => allCenters.find((c) => c.id === user?.centerID),
    [allCenters, user?.centerID]
  )

  // The center whose area we're showing events for. The card is a dropdown:
  // "__all__" = events from every center (no proximity scoping); null = default
  // to the member's home center; any id = that center's area. Events are sorted
  // (never filtered) by nearness, so the list never empties.
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

  // Bottom sheet state
  const [sheetSnap, setSheetSnap] = useState<SheetSnap>('collapsed')
  const [sheetTranslateY, setSheetTranslateY] = useState<number | null>(null)
  const dragStartY = useRef(0)
  const dragStartTranslate = useRef(0)
  const containerRef = useRef<HTMLDivElement>(null)

  // Sheet snap positions matching iOS native (4 stops):
  //   expanded  = 0          -> 100% sheet visible (full)
  //   mid       = h * 0.2    -> 80% sheet visible
  //   collapsed = h * 2/3    -> 33% sheet visible
  //   peek      = h - 100    -> 100px sheet visible (handle + search)
  const getSnapPositions = useCallback(() => {
    const h = containerRef.current?.clientHeight || window.innerHeight
    return {
      expanded: 0,
      mid: h * 0.2,
      collapsed: h * (2 / 3),
      peek: Math.max(0, h - 100),
    }
  }, [])

  const getSnapY = useCallback(
    (snap: SheetSnap) => {
      const positions = getSnapPositions()
      return positions[snap]
    },
    [getSnapPositions]
  )

  const currentTranslateY = sheetTranslateY ?? getSnapY(sheetSnap)

  // Pointer handlers for the bottom-sheet drag. Pointer events cover touch,
  // mouse, and stylus on every modern browser - the sheet was touch-only, so
  // it didn't drag with a pointer/trackpad or in a device-emulated mobile
  // viewport (issue #321).
  const handleDragStart = useCallback(
    (e: React.PointerEvent) => {
      // Don't hijack taps that begin on an interactive control (center card,
      // filter chips, search) - capturing the pointer here swallows their
      // click. Dragging still works from the handle bar and empty header gaps.
      const target = e.target as HTMLElement | null
      if (target?.closest('[role="button"], input, textarea, select, a')) return
      e.currentTarget.setPointerCapture(e.pointerId)
      dragStartY.current = e.clientY
      dragStartTranslate.current = currentTranslateY
    },
    [currentTranslateY]
  )

  const handleDragMove = useCallback(
    (e: React.PointerEvent) => {
      // pointermove also fires on hover - only act during a captured drag.
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
      const dy = e.clientY - dragStartY.current
      const positions = getSnapPositions()
      const next = Math.max(
        positions.expanded,
        Math.min(positions.peek, dragStartTranslate.current + dy)
      )
      setSheetTranslateY(next)
    },
    [getSnapPositions]
  )

  const handleDragEnd = useCallback(
    (e: React.PointerEvent) => {
      if (sheetTranslateY === null) return
      const positions = getSnapPositions()
      const dragDy = e.clientY - dragStartY.current

      // Snap to nearest of 4 positions, biased by velocity
      let snapTo: SheetSnap
      if (dragDy > 40) {
        // Fast swipe down - go one stop down from current
        if (sheetSnap === 'expanded') snapTo = 'mid'
        else if (sheetSnap === 'mid') snapTo = 'collapsed'
        else snapTo = 'peek'
      } else if (dragDy < -40) {
        // Fast swipe up - go one stop up from current
        if (sheetSnap === 'peek') snapTo = 'collapsed'
        else if (sheetSnap === 'collapsed') snapTo = 'mid'
        else snapTo = 'expanded'
      } else {
        // Position-based snap to nearest
        const dExp = Math.abs(sheetTranslateY - positions.expanded)
        const dMid = Math.abs(sheetTranslateY - positions.mid)
        const dCol = Math.abs(sheetTranslateY - positions.collapsed)
        const dPeek = Math.abs(sheetTranslateY - positions.peek)
        const minD = Math.min(dExp, dMid, dCol, dPeek)
        snapTo =
          minD === dExp ? 'expanded' : minD === dMid ? 'mid' : minD === dCol ? 'collapsed' : 'peek'
      }

      setSheetSnap(snapTo)
      setSheetTranslateY(null)
    },
    [sheetTranslateY, sheetSnap, getSnapPositions]
  )

  const handlePointPress = useCallback(
    (point: MapPoint) => {
      track('map_point_pressed', { type: point.type, id: point.id, source: 'discover' })
      if (point.type === 'center') {
        router.push(`/center/${point.id}`)
      } else {
        router.push(`/events/${point.id}`)
      }
    },
    [router, track]
  )

  const displayItems = useMemo(() => {
    let result = items
    if (selectedDate) {
      result = result.filter(
        (item) => item.type === 'event' && (item.data as EventDisplay).date === selectedDate
      )
    }
    // An explicit center pick filters events to that center + a 100mi radius.
    // The default / home-center case below only sorts, so the list never starts empty.
    if (areaCenter && selectedCenter && !isAllCenters && result.every((i) => i.type === 'event')) {
      result = result.filter((item) => {
        const e = item.data as EventDisplay
        return e.centerId === areaCenter.id || milesBetween(areaCenter, e) <= 100
      })
    }
    // Order events by nearness to the selected area center so "what's on around
    // <center>" surfaces first. Sorting (not filtering) keeps the list from ever
    // going empty. Only applies to a flat events list.
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

  // One picker row (mobile-web). Centers WITH events scope the list + fly the
  // map; centers WITHOUT events only open the center page.
  const renderCenterRow = (opt: FilterPickerOption<string>) => {
    const selectable = (opt.count ?? 0) > 0
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
            <View className="w-10 h-10 rounded-xl items-center justify-center" style={{ backgroundColor: isDark ? 'rgba(232,134,42,0.18)' : '#FDE8D0' }}>
              <Building2 size={18} color="#E8862A" />
            </View>
            <View style={{ flex: 1 }}>
              <Text className="text-content dark:text-content-dark font-sans" style={{ fontSize: 15 }} numberOfLines={1}>{opt.label}</Text>
              <Text className="text-stone-500 dark:text-stone-400 font-sans" style={{ fontSize: 12.5 }} numberOfLines={1}>{opt.sublabel}</Text>
            </View>
          </Pressable>
          {selectable ? (
            <View className="rounded-full px-2.5 py-1" style={{ backgroundColor: isDark ? 'rgba(232,134,42,0.18)' : '#FDE8D0' }}>
              <Text className="font-sans" style={{ fontSize: 12, fontWeight: '600', color: '#E8862A' }}>{opt.count} {opt.count === 1 ? 'event' : 'events'}</Text>
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

  // Filter chip helpers - counts over upcoming events.
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

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Map - full bleed behind the sheet */}
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
        <Suspense
          fallback={
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
              <ActivityIndicator size="large" color="#E8862A" />
            </View>
          }
        >
          <Map points={mapPoints} onPointPress={handlePointPress} userCenterID={user?.centerID} flyTo={mapFlyTo} />
        </Suspense>
      </View>

      {/* Bottom Sheet */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          top: currentTranslateY,
          transition: sheetTranslateY !== null ? 'none' : 'top 0.3s cubic-bezier(0.25, 1, 0.5, 1)',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 10,
        }}
      >
        <div
          style={{
            flex: 1,
            backgroundColor: isDark ? '#171717' : '#FFFFFF',
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            boxShadow: '0 -4px 20px rgba(0,0,0,0.12)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Drag Handle Zone */}
          <div
            onPointerDown={handleDragStart}
            onPointerMove={handleDragMove}
            onPointerUp={handleDragEnd}
            style={{
              display: 'flex',
              flexDirection: 'column',
              touchAction: 'none',
              cursor: 'grab',
              userSelect: 'none',
              WebkitUserSelect: 'none',
            }}
          >
            {/* Handle bar */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                paddingTop: 10,
                paddingBottom: 8,
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: isDark ? '#525252' : '#D1D5DB',
                }}
              />
            </div>

            {/* Search */}
            <View
              className="flex-row items-center mx-3 mb-2 px-3 rounded-xl"
              style={{
                minHeight: 44,
                backgroundColor: isDark ? '#262626' : '#F3F4F6',
              }}
            >
              <Search size={16} color="#9CA3AF" />
              <TextInput
                className="flex-1 ml-2 text-sm font-sans"
                style={{
                  color: isDark ? '#E5E7EB' : '#1F2937',
                  paddingVertical: 10,
                  fontSize: 16,
                }}
                placeholder={centerPickerOpen ? 'Search centers...' : 'Search events...'}
                placeholderTextColor="#9CA3AF"
                value={searchQuery}
                onChangeText={setSearchQuery}
                onFocus={() => setSheetSnap('expanded')}
                onEndEditing={() => {
                  if (searchQuery.trim()) {
                    track('discover_search', { query: searchQuery.trim(), source: 'discover' })
                  }
                }}
              />
            </View>

            {/* Center dropdown - picks which center's area to show events for.
                Defaults to the member's home center; tapping opens the in-sheet
                center list so they can see what's on around any center. */}
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
                className="flex-row items-center mx-3 mb-2 px-3 rounded-2xl active:opacity-70"
                style={{
                  alignSelf: 'stretch',
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

            {/* In-sheet center picker header - title + Close. The list itself
                renders in the ScrollView below. */}
            {centerPickerOpen && (
              <View
                className="flex-row items-center justify-between px-4"
                style={{ paddingTop: 2, paddingBottom: 8 }}
              >
                <Text className="font-sans text-stone-500 dark:text-stone-400 uppercase" style={{ fontSize: 11.5, letterSpacing: 0.9 }}>
                  Show events near
                </Text>
                <Pressable accessibilityRole="button" onPress={() => setCenterPickerOpen(false)} hitSlop={8}>
                  <Text style={{ fontSize: 13, fontWeight: '500', color: '#E8862A' }}>Close</Text>
                </Pressable>
              </View>
            )}

            {/* Filter chips - Today / Going + Create button */}
            {!centerPickerOpen && (
              <View className="flex-row items-center px-4 py-1.5" style={{ gap: 8 }}>
                <View className="flex-1 flex-row flex-wrap items-center" style={{ gap: 8 }}>
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
                        setShowGoingOnly((prev: boolean) => !prev)
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
          </div>

          {/* Loading skeleton */}
          {loading && (
            <View style={{ paddingHorizontal: 12 }}>
              <DiscoverListSkeleton count={4} />
            </View>
          )}

          {/* Scrollable list */}
          <ScrollView
            className="flex-1"
            contentContainerStyle={{ paddingHorizontal: 4, paddingTop: 12, paddingBottom: 32, gap: 4 }}
            showsVerticalScrollIndicator={false}
            scrollEnabled={centerPickerOpen || (sheetSnap !== 'collapsed' && sheetTranslateY === null)}
          >
            {/* In-sheet center picker - "Show events near <center>". */}
            {centerPickerOpen && (
              <>
                {/* All centers - show events from every center, no area scoping. */}
                <Pressable
                  onPress={() => {
                    track('explore_area_all_selected')
                    setSelectedCenter('__all__')
                    setCenterPickerOpen(false)
                    setSearchQuery('')
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
            {!centerPickerOpen && displayItems.map((item) => {
              if (item.type !== 'event') return null
              return (
                <ExploreEventItem
                  key={`event-${item.data.id}`}
                  event={item.data as EventDisplay}
                  centerName={allCenters.find((c) => c.id === (item.data as EventDisplay).centerId)?.name}
                  onPress={() => {
                    track('event_list_item_pressed', { eventId: item.data.id, source: 'discover' })
                    router.push(`/events/${item.data.id}`)
                  }}
                />
              )
            })}
          </ScrollView>
        </div>
      </div>
    </div>
  )
}

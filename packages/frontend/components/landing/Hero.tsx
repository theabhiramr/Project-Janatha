import React, { useEffect, useMemo, useRef } from 'react'
import { View, Text, Pressable, Platform, useWindowDimensions, ScrollView, Image } from 'react-native'
import { useRouter } from 'expo-router'
import { usePostHog } from 'posthog-react-native'
import { useEventList, useCenterList } from '../../hooks/useApiData'
import type { EventDisplay, DiscoverCenter } from '../../utils/api'

// Inject CSS keyframes for the infinite scroll animation (web only)
if (Platform.OS === 'web' && typeof document !== 'undefined') {
  const id = 'hero-scroll-keyframes'
  if (!document.getElementById(id)) {
    const style = document.createElement('style')
    style.id = id
    style.textContent = `
      @keyframes heroScroll {
        0% { transform: translateY(0); }
        100% { transform: translateY(-50%); }
      }
      @keyframes heroScrollHorizontal {
        0% { transform: translateX(0); }
        100% { transform: translateX(-50%); }
      }
      .avatar-wrap {
        position: relative;
      }
      .avatar-wrap .avatar-tooltip {
        position: absolute;
        bottom: calc(100% + 6px);
        left: 50%;
        transform: translateX(-50%) scale(0.9);
        background: #1C1917;
        color: #fff;
        font-family: Inter, sans-serif;
        font-size: 11px;
        font-weight: 500;
        padding: 4px 10px;
        border-radius: 6px;
        white-space: nowrap;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.15s ease, transform 0.15s ease;
      }
      .avatar-wrap .avatar-tooltip::after {
        content: '';
        position: absolute;
        top: 100%;
        left: 50%;
        transform: translateX(-50%);
        border: 4px solid transparent;
        border-top-color: #1C1917;
      }
      .avatar-wrap:hover .avatar-tooltip {
        opacity: 1;
        transform: translateX(-50%) scale(1);
      }
      .avatar-wrap {
        transition: transform 0.15s ease, z-index 0s;
        z-index: 0;
      }
      .avatar-wrap:hover {
        transform: scale(1.25);
        z-index: 10;
      }
    `
    document.head.appendChild(style)
  }
}

interface CardData {
  type: 'event' | 'center' | 'stat'
  title: string
  subtitle: string
  color: string
  icon?: string
  stat?: string
  image?: any
}

const FALLBACK_EVENT_IMAGES = [
  require('../../assets/images/landing/Swami Chinmayananda.jpg'),
  require('../../assets/images/landing/youth-group.jpg'),
  require('../../assets/images/landing/vedanta-class.jpg'),
  require('../../assets/images/landing/bala-vihar.jpg'),
  require('../../assets/images/landing/devi-group.jpg'),
  require('../../assets/images/landing/meditation.jpg'),
]

const EVENT_CARD_COLORS = ['#FED7AA', '#BFDBFE', '#D9F99D', '#FBCFE8', '#FDE68A', '#E9D5FF']

const FALLBACK_CARDS: CardData[] = [
  {
    type: 'event',
    title: 'Geeta Chanting',
    subtitle: 'Mar 15 · 6:00 PM',
    color: '#FED7AA',
    image: FALLBACK_EVENT_IMAGES[0],
  },
  { type: 'center', title: 'CM San Jose', subtitle: 'San Jose, CA', color: '#F5F0EB', icon: 'S' },
  { type: 'event', title: 'Youth Retreat', subtitle: 'Apr 2 · 9:00 AM', color: '#BFDBFE', image: FALLBACK_EVENT_IMAGES[1] },
  { type: 'stat', title: '1,240 Members', subtitle: 'Active this month', color: '#F0FDF4', stat: '1,240' },
  { type: 'event', title: 'Vedanta Course', subtitle: 'Mar 22 · 7:00 PM', color: '#D9F99D', image: FALLBACK_EVENT_IMAGES[2] },
  { type: 'center', title: 'CM Houston', subtitle: 'Houston, TX', color: '#F5F0EB', icon: 'H' },
  { type: 'event', title: 'Bala Vihar', subtitle: 'Every Sunday · 10 AM', color: '#FBCFE8', image: FALLBACK_EVENT_IMAGES[3] },
  { type: 'stat', title: '86 Events', subtitle: 'This month', color: '#EFF6FF', stat: '86' },
  { type: 'center', title: 'CM Chicago', subtitle: 'Chicago, IL', color: '#F5F0EB', icon: 'C' },
  { type: 'event', title: 'Devi Group', subtitle: 'Mar 18 · 7:30 PM', color: '#FDE68A', image: FALLBACK_EVENT_IMAGES[4] },
  { type: 'event', title: 'Meditation', subtitle: 'Daily · 6:00 AM', color: '#E9D5FF', image: FALLBACK_EVENT_IMAGES[5] },
]

function formatEventDate(date: string, time: string): string {
  // date is "YYYY-MM-DD"; time is a localized string like "6:00 PM"
  if (!date) return time || 'Upcoming'
  const parsed = new Date(`${date}T00:00:00`)
  if (isNaN(parsed.getTime())) return time || 'Upcoming'
  const month = parsed.toLocaleDateString('en-US', { month: 'short' })
  const day = parsed.getDate()
  return time ? `${month} ${day} · ${time}` : `${month} ${day}`
}

function shortCenterAddress(address?: string): string {
  // Pull "City, State" out of full street address. Falls back to raw address.
  if (!address) return ''
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]
  // Last part often has "State ZIP" or "Country" — keep state token only
  const last = parts[parts.length - 1]
  const state = last.split(/\s+/)[0]
  const city = parts[parts.length - 2]
  return state ? `${city}, ${state}` : city
}

function buildLiveCards(events: EventDisplay[], centers: DiscoverCenter[]): CardData[] {
  if (events.length === 0 && centers.length === 0) return []

  const todayStr = new Date().toISOString().split('T')[0]
  const upcoming = events
    .filter((e) => !e.date || e.date >= todayStr)
    .sort((a, b) => a.date.localeCompare(b.date))

  const eventCards: CardData[] = upcoming.slice(0, 8).map((e, i) => ({
    type: 'event',
    title: e.title,
    subtitle: formatEventDate(e.date, e.time),
    color: EVENT_CARD_COLORS[i % EVENT_CARD_COLORS.length],
    image: e.image ? { uri: e.image } : FALLBACK_EVENT_IMAGES[i % FALLBACK_EVENT_IMAGES.length],
  }))

  const centerCards: CardData[] = centers.slice(0, 4).map((c) => ({
    type: 'center',
    title: c.name,
    subtitle: shortCenterAddress(c.address),
    color: '#F5F0EB',
    icon: (c.name?.[0] || 'C').toUpperCase(),
  }))

  const totalMembers = centers.reduce((sum, c) => sum + (c.memberCount ?? 0), 0)

  // Count events scheduled in the current calendar month
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString().split('T')[0]
  const eventsThisMonth = events.filter((e) => e.date && e.date >= monthStart && e.date < monthEnd).length

  const statCards: CardData[] = []
  if (totalMembers > 0) {
    const formatted = totalMembers.toLocaleString()
    statCards.push({
      type: 'stat',
      title: `${formatted} Members`,
      subtitle: 'Across centers',
      color: '#F0FDF4',
      stat: formatted,
    })
  }
  if (eventsThisMonth > 0) {
    statCards.push({
      type: 'stat',
      title: `${eventsThisMonth} Events`,
      subtitle: 'This month',
      color: '#EFF6FF',
      stat: eventsThisMonth.toString(),
    })
  }
  if (centers.length > 0) {
    const centerCount = centers.length.toString()
    statCards.push({
      type: 'stat',
      title: `${centerCount} Centers`,
      subtitle: 'Worldwide',
      color: '#FFF7ED',
      stat: centerCount,
    })
  }

  // Interleave: event-heavy with centers/stats sprinkled in. Pattern: E,E,C,E,S,E,C,E,M,E,C,E
  const result: CardData[] = []
  let ei = 0,
    ci = 0,
    si = 0
  const accents = [...statCards] // mutable queue of stat/map cards
  const ratio = [
    'event',
    'event',
    'center',
    'event',
    'accent',
    'event',
    'center',
    'event',
    'accent',
    'event',
    'center',
    'event',
    'accent',
    'event',
  ] as const
  for (const slot of ratio) {
    if (slot === 'event' && ei < eventCards.length) {
      result.push(eventCards[ei++])
    } else if (slot === 'center' && ci < centerCards.length) {
      result.push(centerCards[ci++])
    } else if (slot === 'accent' && si < accents.length) {
      result.push(accents[si++])
    }
  }
  // Append any leftovers so nothing is dropped
  while (ei < eventCards.length) result.push(eventCards[ei++])
  while (ci < centerCards.length) result.push(centerCards[ci++])
  while (si < accents.length) result.push(accents[si++])

  return result
}

function ScrollCard({ card, width }: { card: CardData; width: number }) {
  const isLarge = width >= 240
  const imageHeight = isLarge ? 132 : 100
  const titleSize = isLarge ? 15 : 13
  const subtitleSize = isLarge ? 12 : 11
  const padding = isLarge ? 16 : 14
  const radius = isLarge ? 16 : 14
  const iconBoxSize = isLarge ? 44 : 40
  const iconFontSize = isLarge ? 18 : 16
  const statSize = isLarge ? 32 : 28

  if (card.type === 'event') {
    return (
      <View
        style={{
          width,
          backgroundColor: '#FFFFFF',
          borderRadius: radius,
          padding,
          boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
        }}
      >
        {card.image ? (
          <Image
            source={card.image}
            resizeMode="cover"
            style={{
              width: '100%',
              height: imageHeight,
              borderRadius: 8,
              marginBottom: 10,
            }}
          />
        ) : (
          <View
            style={{
              width: '100%',
              height: imageHeight,
              borderRadius: 8,
              backgroundColor: card.color,
              marginBottom: 10,
            }}
          />
        )}
        <Text
          style={{
            fontFamily: 'Inclusive Sans, sans-serif',
            fontWeight: '600',
            fontSize: titleSize,
            color: '#1C1917',
            marginBottom: 3,
          }}
        >
          {card.title}
        </Text>
        <Text style={{ fontFamily: 'Inclusive Sans, sans-serif', fontSize: subtitleSize, color: '#78716C' }}>
          {card.subtitle}
        </Text>
      </View>
    )
  }

  if (card.type === 'center') {
    return (
      <View
        style={{
          width,
          backgroundColor: '#FFFFFF',
          borderRadius: radius,
          padding,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
        }}
      >
        <View
          style={{
            width: iconBoxSize,
            height: iconBoxSize,
            borderRadius: 10,
            backgroundColor: card.color,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text
            style={{
              fontFamily: 'Inclusive Sans, sans-serif',
              fontWeight: '700',
              fontSize: iconFontSize,
              color: '#C2410C',
            }}
          >
            {card.icon}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text
            style={{
              fontFamily: 'Inclusive Sans, sans-serif',
              fontWeight: '600',
              fontSize: titleSize,
              color: '#1C1917',
              marginBottom: 2,
            }}
          >
            {card.title}
          </Text>
          <Text style={{ fontFamily: 'Inclusive Sans, sans-serif', fontSize: subtitleSize, color: '#78716C' }}>
            {card.subtitle}
          </Text>
        </View>
      </View>
    )
  }

  // stat card
  return (
    <View
      style={{
        width,
        backgroundColor: '#FFFFFF',
        borderRadius: radius,
        padding,
        boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
      }}
    >
      <Text
        style={{
          fontFamily: '"Inclusive Sans", sans-serif',
          fontWeight: '400',
          fontSize: statSize,
          color: '#C2410C',
          marginBottom: 2,
        }}
      >
        {card.stat}
      </Text>
      <Text
        style={{
          fontFamily: 'Inclusive Sans, sans-serif',
          fontWeight: '600',
          fontSize: titleSize,
          color: '#1C1917',
          marginBottom: 2,
        }}
      >
        {card.title.replace(card.stat + ' ', '')}
      </Text>
      <Text style={{ fontFamily: 'Inclusive Sans, sans-serif', fontSize: subtitleSize, color: '#78716C' }}>
        {card.subtitle}
      </Text>
    </View>
  )
}

function InfiniteScrollColumn({
  cards,
  speed,
  offset,
  cardWidth,
  height,
}: {
  cards: CardData[]
  speed: number
  offset: number
  cardWidth: number
  height: number
}) {
  // Duplicate cards for seamless loop
  const doubled = [...cards, ...cards]

  return (
    <View style={{ overflow: 'hidden', height, marginTop: offset, paddingHorizontal: 14 }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          animation: `heroScroll ${speed}s linear infinite`,
        }}
      >
        {doubled.map((card, i) => (
          <ScrollCard key={`${card.title}-${i}`} card={card} width={cardWidth} />
        ))}
      </div>
    </View>
  )
}

type TeamMember = { name: string; image: any; color?: string }

const TEAM: TeamMember[] = [
  { name: 'Abhiram', image: require('../../assets/images/landing/abhiram.jpg') },
  { name: 'Kish', image: require('../../assets/images/landing/kish.jpg') },
  { name: 'Sahanav', image: require('../../assets/images/landing/sahanav.jpg') },
  { name: 'Divita', image: require('../../assets/images/landing/divita.jpg') },
  { name: 'Pranav', image: require('../../assets/images/landing/pranav.jpg') },
]

function AvatarStack() {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {TEAM.map((person, i) => (
        <div key={person.name} className="avatar-wrap" style={{ marginLeft: i > 0 ? -10 : 0, cursor: 'default', zIndex: TEAM.length - i }}>
          <div className="avatar-tooltip">{person.name}</div>
          {person.image ? (
            <Image
              source={person.image}
              style={{
                width: 38,
                height: 38,
                borderRadius: 19,
                borderWidth: 2,
                borderColor: '#FAFAF7',
              }}
            />
          ) : (
            <View
              style={{
                width: 38,
                height: 38,
                borderRadius: 19,
                backgroundColor: person.color ?? '#9CA3AF',
                borderWidth: 2,
                borderColor: '#FAFAF7',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontFamily: 'Inclusive Sans, sans-serif', fontWeight: '600', fontSize: 14, color: '#FFFFFF' }}>
                {person.name[0]}
              </Text>
            </View>
          )}
        </div>
      ))}
    </View>
  )
}

function HorizontalScrollRow({ cards }: { cards: CardData[] }) {
  const doubled = [...cards, ...cards]

  return (
    <View style={{ overflow: 'hidden', marginTop: 32, marginHorizontal: -20, position: 'relative', paddingVertical: 14 }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          gap: 14,
          animation: `heroScrollHorizontal 25s linear infinite`,
        }}
      >
        {doubled.map((card, i) => (
          <View key={`${card.title}-h-${i}`} style={{ flexShrink: 0 }}>
            <ScrollCard card={card} width={220} />
          </View>
        ))}
      </div>
    </View>
  )
}

export function Hero() {
  const router = useRouter()
  const posthog = usePostHog()
  const { width } = useWindowDimensions()
  const isMobile = width < 768
  const isTablet = width >= 768 && width < 1024

  const { events } = useEventList()
  const { centers } = useCenterList()

  // Build live cards once data arrives. Need at least 6 to look reasonable in the
  // multi-column scroller; otherwise fall back to the curated set so the hero never
  // looks sparse during loading or in degraded states.
  const cards = useMemo(() => {
    const live = buildLiveCards(events, centers)
    return live.length >= 6 ? live : FALLBACK_CARDS
  }, [events, centers])

  // Estimate the right column's width so the floating card area never extends
  // past it into the headline text. The hero uses two flex:1 columns with
  // leftCol capped at maxWidth 560 — mirror that here so the cards fit.
  const heroPaddingTop = isMobile ? 60 : 100
  const heroPaddingBottom = isMobile ? 40 : 80
  const heroPaddingLeft = isMobile ? 20 : isTablet ? 40 : 80
  const heroPaddingRight = isMobile ? 20 : 0
  const cardsRightOffset = isTablet ? 54 : 34
  const colGap = 14
  const colInnerPadding = 14 // matches InfiniteScrollColumn paddingHorizontal
  const availInner = Math.max(0, width - heroPaddingLeft - heroPaddingRight)
  const leftColW = Math.min(560, availInner / 2)
  const rightColW = Math.max(0, availInner - leftColW)
  // The container is right-anchored with `right: -cardsRightOffset`, so its
  // width may exceed the right column by exactly that offset before its left
  // edge crosses into the leftCol.
  const maxCardsContainer = Math.floor(rightColW + cardsRightOffset)

  const fits = (cols: number, cw: number) =>
    cols * cw + colInnerPadding * 2 * cols + colGap * (cols - 1) <= maxCardsContainer

  let numColumns = 2
  let cardWidth = 220
  if (fits(3, 280)) {
    numColumns = 3
    cardWidth = 280
  } else if (fits(3, 260)) {
    numColumns = 3
    cardWidth = 260
  } else if (fits(3, 240)) {
    numColumns = 3
    cardWidth = 240
  } else if (fits(2, 280)) {
    numColumns = 2
    cardWidth = 280
  } else if (fits(2, 260)) {
    numColumns = 2
    cardWidth = 260
  } else if (fits(2, 240)) {
    numColumns = 2
    cardWidth = 240
  } else if (fits(2, 220)) {
    numColumns = 2
    cardWidth = 220
  } else {
    numColumns = 2
    cardWidth = Math.max(180, Math.floor((maxCardsContainer - colInnerPadding * 4 - colGap) / 2))
  }
  const cardsContainerWidth =
    numColumns * cardWidth + colInnerPadding * 2 * numColumns + colGap * (numColumns - 1)

  const cardColumns = useMemo(() => {
    const cols: CardData[][] = Array.from({ length: numColumns }, () => [])
    cards.forEach((card, i) => {
      cols[i % numColumns].push(card)
    })
    return cols
  }, [cards, numColumns])

  // Column scrollers must comfortably exceed the visible hero so a full
  // animation cycle is always covered as the cards translate vertically.
  const columnHeight = 1100

  return (
    <View
      style={{
        position: 'relative',
        overflow: 'hidden',
        paddingTop: heroPaddingTop,
        paddingBottom: heroPaddingBottom,
        paddingLeft: heroPaddingLeft,
        paddingRight: heroPaddingRight,
        minHeight: isMobile ? undefined : 656,
        backgroundColor: '#FAFAF7',
        flexDirection: isMobile ? 'column' : 'row',
      }}
    >
      {/* Left column */}
      <View style={{ flex: isMobile ? undefined : 1, maxWidth: isMobile ? undefined : 560, zIndex: 1 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            marginBottom: 16,
          }}
        >
          <View
            style={{
              backgroundColor: '#FFF7ED',
              borderWidth: 1,
              borderColor: '#FDBA74',
              paddingHorizontal: 10,
              paddingVertical: 4,
              borderRadius: 100,
            }}
          >
            <Text
              style={{
                fontFamily: 'Inclusive Sans, sans-serif',
                fontWeight: '600',
                fontSize: 12,
                color: '#C2410C',
              }}
            >
              Beta
            </Text>
          </View>
          <Text
            style={{
              fontFamily: 'Inclusive Sans, sans-serif',
              fontSize: 13,
              color: '#A8A29E',
            }}
          >
            Currently available on web
          </Text>
        </View>

        <Text
          style={{
            fontFamily: '"Inclusive Sans", sans-serif',
            fontWeight: '400',
            fontSize: isMobile ? 42 : isTablet ? 56 : 72,
            lineHeight: isMobile ? 48 : isTablet ? 64 : 80,
            letterSpacing: -0.02 * (isMobile ? 42 : isTablet ? 56 : 72),
            color: '#1C1917',
            marginBottom: 24,
          }}
        >
          {'Find your center.\nGrow together.'}
        </Text>

        <Text
          style={{
            fontFamily: 'Inclusive Sans, sans-serif',
            fontWeight: '400',
            fontSize: isMobile ? 16 : 20,
            lineHeight: isMobile ? 26 : 32,
            color: '#78716C',
            marginBottom: 40,
            maxWidth: 480,
          }}
        >
          One place where any CHYK can find events and centers nearby, RSVP in a tap, and run their
          own events without juggling five group chats.
        </Text>

        {/* CTAs */}
        <View
          style={{
            flexDirection: isMobile ? 'column' : 'row',
            gap: 16,
            marginBottom: 48,
          }}
        >
          <Pressable
            onPress={() => {
              posthog?.capture('landing_cta_pressed', { variant: 'hero', label: 'start_exploring' })
              router.push('/explore')
            }}
            className="bg-primary active:bg-primary-press rounded-full"
            style={{
              paddingHorizontal: 28,
              paddingVertical: 14,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              ...(isMobile ? { width: '100%' } : {}),
            }}
          >
            <Text
              style={{
                fontFamily: 'Inclusive Sans, sans-serif',
                fontWeight: '500',
                fontSize: 16,
                color: '#FFFFFF',
              }}
            >
              Start Exploring →
            </Text>
          </Pressable>

        </View>

        {/* Avatar stack + tagline */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <AvatarStack />
          <Text style={{ fontFamily: 'Inclusive Sans, sans-serif', fontSize: 14, color: '#78716C' }}>
            By CHYKs, for CHYKs.
          </Text>
        </View>

        {/* Horizontal scrolling card row on mobile — hidden for now */}
        {/* {isMobile && <HorizontalScrollRow />} */}
      </View>

      {/* Infinite scrolling card columns -- rotated (hidden on mobile).
          Negative top/bottom margins extend the column through the hero's
          padding so the cards fill the full hero height edge-to-edge. */}
      {!isMobile && (
        <View
          style={{
            flex: 1,
            position: 'relative',
            minHeight: 560 + heroPaddingTop + heroPaddingBottom,
            overflow: 'hidden',
            paddingHorizontal: 14,
            marginTop: -heroPaddingTop,
            marginBottom: -heroPaddingBottom,
          }}
        >
          <View
            style={{
              position: 'absolute',
              top: -120,
              right: -cardsRightOffset,
              width: cardsContainerWidth,
              height: columnHeight + 200,
              transform: 'rotate(-4deg)',
              flexDirection: 'row',
              gap: colGap,
            }}
          >
            {cardColumns.map((colCards, i) => {
              const speeds = [30, 25, 28]
              const offsets = [0, -60, -30]
              return (
                <InfiniteScrollColumn
                  key={i}
                  cards={colCards}
                  cardWidth={cardWidth}
                  height={columnHeight}
                  speed={speeds[i % speeds.length]}
                  offset={offsets[i % offsets.length]}
                />
              )
            })}
          </View>
          {/* Fade edges */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: 120,
              zIndex: 2,
              pointerEvents: 'none',
              background: 'linear-gradient(180deg, #FAFAF7 20%, rgba(250, 250, 247, 0))',
            }}
          />
          <div
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              height: 140,
              zIndex: 2,
              pointerEvents: 'none',
              background: 'linear-gradient(0deg, #FAFAF7 15%, rgba(250, 250, 247, 0))',
            }}
          />
        </View>
      )}
    </View>
  )
}

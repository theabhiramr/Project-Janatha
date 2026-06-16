import React from 'react'
import { Pressable, Text, View } from 'react-native'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { Building2, CalendarDays, Megaphone, PencilLine, Sparkles } from 'lucide-react-native'
import type { AppColors } from '../../tokens'

// A single dimmed skeleton post. Shared by the feed's loading state and the
// empty state's "ghost feed" so the placeholder shape stays identical to a real
// post card (avatar + name + two text lines + a faint reaction row).
export function GhostPostCard({ colors, opacity = 1 }: { colors: AppColors; opacity?: number }) {
  const bar = (w: number | string, h = 12) => (
    <View style={{ width: w as any, height: h, borderRadius: h / 2, backgroundColor: colors.panel }} />
  )
  return (
    <View
      style={{
        opacity,
        backgroundColor: colors.card,
        borderRadius: 16,
        padding: 16,
        borderWidth: 1,
        borderColor: colors.border,
        gap: 12,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ width: 40, height: 40, borderRadius: 14, backgroundColor: colors.panel }} />
        <View style={{ flex: 1, gap: 6 }}>
          {bar('45%', 13)}
          {bar('25%', 11)}
        </View>
      </View>
      {bar('85%')}
      {bar('60%')}
      <View style={{ flexDirection: 'row', gap: 14, marginTop: 2 }}>
        {bar(48, 14)}
        {bar(48, 14)}
      </View>
    </View>
  )
}

const WELCOME_FEATURES: { icon: typeof Building2; label: string; hint: string }[] = [
  { icon: Building2, label: 'Your center board', hint: 'Stay in the loop with members at your home center.' },
  { icon: CalendarDays, label: 'Event boards', hint: 'Coordinate around every event you RSVP to.' },
  { icon: Megaphone, label: "What's happening", hint: 'News across Chinmaya Mission, as it happens.' },
]

// Static, non-interactive explainer card that stands in for real feed content
// until public posts exist. It tells a first-timer what this feed becomes once
// they join — the right rail handles how (sign in / join a center).
function WelcomeCard({ colors }: { colors: AppColors }) {
  return (
    <View
      style={{
        backgroundColor: colors.card,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: colors.border,
        padding: 18,
        gap: 16,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View
          style={{
            width: 42,
            height: 42,
            borderRadius: 13,
            backgroundColor: colors.accentSoft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Sparkles size={20} color={colors.accent} strokeWidth={2.2} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 18, color: colors.text }}>
            Your community feed
          </Text>
          <Text style={{ fontSize: 13.5, lineHeight: 19, color: colors.textMuted, marginTop: 2 }}>
            One place for your center and the events you attend.
          </Text>
        </View>
      </View>
      <View style={{ gap: 13 }}>
        {WELCOME_FEATURES.map((f) => {
          const Icon = f.icon
          return (
            <View key={f.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 11,
                  backgroundColor: colors.panel,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon size={17} color={colors.accent} strokeWidth={2.2} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14.5, color: colors.text }}>{f.label}</Text>
                <Text style={{ fontSize: 12.5, lineHeight: 17, color: colors.textMuted }}>{f.hint}</Text>
              </View>
            </View>
          )
        })}
      </View>
    </View>
  )
}

// "Be the first to post" nudge — shown when the member already has boards but no
// posts have landed yet. Wired to the compose sheet.
function FirstPostCard({ colors, centerName, onCompose }: { colors: AppColors; centerName?: string; onCompose?: () => void }) {
  return (
    <View
      style={{
        backgroundColor: colors.card,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: colors.border,
        padding: 18,
        gap: 14,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View
          style={{
            width: 42,
            height: 42,
            borderRadius: 13,
            backgroundColor: colors.accentSoft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <PencilLine size={20} color={colors.accent} strokeWidth={2.2} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 18, color: colors.text }}>
            You're in. Start the conversation.
          </Text>
          <Text style={{ fontSize: 13.5, lineHeight: 19, color: colors.textMuted, marginTop: 2 }}>
            {centerName
              ? `Share the first post with ${centerName} and your event boards.`
              : 'Share the first post with your center and event boards.'}
          </Text>
        </View>
      </View>
      <Pressable
        onPress={onCompose}
        accessibilityRole="button"
        accessibilityLabel="Write a post"
        style={{ alignSelf: 'flex-start', backgroundColor: colors.accent, borderRadius: 999, paddingHorizontal: 18, paddingVertical: 11 }}
      >
        <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 14, color: colors.textInverse }}>Write a post</Text>
      </Pressable>
    </View>
  )
}

// The left column of the empty feed: an explainer/nudge card on top, then a
// stack of dimmed ghost posts that fade into the background — a preview of what
// the feed becomes once the user joins.
export function GhostFeed({
  colors,
  variant,
  centerName,
  onCompose,
  showWelcomeCard = true,
}: {
  colors: AppColors
  variant: 'welcome' | 'firstPost'
  centerName?: string
  onCompose?: () => void
  showWelcomeCard?: boolean
}) {
  const ghostOpacities = showWelcomeCard ? [0.5, 0.32, 0.18] : [0.66, 0.46, 0.28, 0.16]
  return (
    <View style={{ gap: 14 }}>
      {showWelcomeCard ? (
        variant === 'welcome' ? (
          <WelcomeCard colors={colors} />
        ) : (
          <FirstPostCard colors={colors} centerName={centerName} onCompose={onCompose} />
        )
      ) : null}

      <View style={{ position: 'relative', gap: 12 }} pointerEvents="none">
        {ghostOpacities.map((opacity, i) => (
          <GhostPostCard key={i} colors={colors} opacity={opacity} />
        ))}
        {/* Fade the ghost stack into the page so it reads as "more to come"
            rather than three broken cards. */}
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 160 }}>
          <Svg width="100%" height="100%">
            <Defs>
              <LinearGradient id="ghostFade" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={colors.bg} stopOpacity={0} />
                <Stop offset="1" stopColor={colors.bg} stopOpacity={1} />
              </LinearGradient>
            </Defs>
            <Rect x="0" y="0" width="100%" height="100%" fill="url(#ghostFade)" />
          </Svg>
        </View>
      </View>
    </View>
  )
}

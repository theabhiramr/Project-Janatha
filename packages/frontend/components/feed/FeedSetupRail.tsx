import React, { useState } from 'react'
import { Image, Pressable, Text, View, type ImageSourcePropType } from 'react-native'
import { Check } from 'lucide-react-native'
import type { AppColors } from '../../tokens'
import { CenterSearch } from '../center/CenterSearch'

type StepState = 'done' | 'active' | 'todo'

const diyaImage = require('../../assets/images/onboarding/diya.png')

function StepDot({ index, state, colors }: { index: number; state: StepState; colors: AppColors }) {
  if (state === 'done') {
    return (
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 14,
          backgroundColor: colors.success,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Check size={16} color={colors.textInverse} strokeWidth={3} />
      </View>
    )
  }
  const active = state === 'active'
  return (
    <View
      style={{
        width: 28,
        height: 28,
        borderRadius: 14,
        backgroundColor: active ? colors.accent : colors.panel,
        borderWidth: active ? 0 : 1,
        borderColor: colors.border,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ fontSize: 13, fontWeight: '700', color: active ? colors.textInverse : colors.textMuted }}>
        {index}
      </Text>
    </View>
  )
}

// State-aware setup panel for the right rail (desktop) / top of the stacked
// empty state (mobile). Walks a first-timer through the two steps that unlock
// the feed: sign in, then join a center. Steps collapse as they complete.
export function FeedSetupRail({
  colors,
  isSignedIn,
  onSignIn,
  onJoinCenter,
  onBrowseEvents,
  onPasteInvite,
  artworkSource,
  signedOutTitle = 'Log in to see your feed.',
  signedOutSubtitle = 'Posts from your center and events will show up here.',
}: {
  colors: AppColors
  isSignedIn: boolean
  onSignIn: () => void
  /** Resolve true on success. Guest mode routes to auth and may not resolve. */
  onJoinCenter: (centerId: string) => Promise<boolean> | void
  onBrowseEvents: () => void
  /** Hard-gate path for the not-yet-invited: paste an invite link or code. */
  onPasteInvite?: () => void
  artworkSource?: ImageSourcePropType
  signedOutTitle?: string
  signedOutSubtitle?: string
}) {
  const [joiningId, setJoiningId] = useState<string | null>(null)
  const setupArtwork = artworkSource ?? diyaImage

  const handleJoin = async (centerId: string) => {
    setJoiningId(centerId)
    try {
      await onJoinCenter(centerId)
    } finally {
      setJoiningId(null)
    }
  }

  const step1: StepState = isSignedIn ? 'done' : 'active'
  const step2: StepState = isSignedIn ? 'active' : 'todo'

  if (!isSignedIn) {
    return (
      <View
        style={{
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 18,
          backgroundColor: colors.card,
          paddingHorizontal: 20,
          paddingTop: 24,
          paddingBottom: 20,
          gap: 20,
        }}
      >
        <View style={{ alignItems: 'center', gap: 12 }}>
          <Image
            source={setupArtwork}
            accessibilityIgnoresInvertColors
            style={{ width: 72, height: 72 }}
            resizeMode="contain"
          />
          <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 22, lineHeight: 28, color: colors.text, textAlign: 'center' }}>
            {signedOutTitle}
          </Text>
          <Text style={{ fontSize: 14, lineHeight: 20, color: colors.textMuted, textAlign: 'center' }}>
            {signedOutSubtitle}
          </Text>
        </View>

        <View style={{ gap: 10 }}>
          <Pressable
            onPress={onSignIn}
            accessibilityRole="button"
            style={({ pressed }) => ({
              minHeight: 48,
              borderRadius: 12,
              backgroundColor: pressed ? colors.accentPress : colors.accent,
              paddingHorizontal: 16,
              alignItems: 'center',
              justifyContent: 'center',
            })}
          >
            <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 15, fontWeight: '600', color: colors.textInverse }}>
              Log in
            </Text>
          </Pressable>

          {onPasteInvite ? (
            <Pressable
              onPress={onPasteInvite}
              accessibilityRole="button"
              style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={{ fontSize: 14, color: colors.textMuted }}>
                Have an invite? <Text style={{ color: colors.accent, fontWeight: '600' }}>Paste it</Text>
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    )
  }

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 18,
        backgroundColor: colors.card,
        padding: 18,
        gap: 4,
      }}
    >
      <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 17, color: colors.text }}>
        {isSignedIn ? 'Almost there' : 'Join the conversation'}
      </Text>
      <Text style={{ fontSize: 13, lineHeight: 18, color: colors.textMuted, marginBottom: 14 }}>
        {isSignedIn
          ? 'Join a center to unlock its boards.'
          : 'Boards for your center and events. Members only.'}
      </Text>

      {/* Step 1 — Sign in */}
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View style={{ alignItems: 'center' }}>
          <StepDot index={1} state={step1} colors={colors} />
          <View style={{ flex: 1, width: 2, backgroundColor: colors.border, marginVertical: 4 }} />
        </View>
        <View style={{ flex: 1, paddingBottom: 16 }}>
          <Text
            style={{
              fontSize: 14.5,
              color: step1 === 'done' ? colors.textMuted : colors.text,
              fontWeight: step1 === 'active' ? '600' : '400',
            }}
          >
            {step1 === 'done' ? 'Logged in' : 'Log in'}
          </Text>
          {step1 === 'active' ? (
            <View style={{ gap: 8 }}>
              <Pressable
                onPress={onSignIn}
                accessibilityRole="button"
                style={{ marginTop: 10, backgroundColor: colors.accent, borderRadius: 999, paddingVertical: 11, alignItems: 'center' }}
              >
                <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 14, color: colors.textInverse }}>
                  Log in
                </Text>
              </Pressable>
              {onPasteInvite ? (
                <Pressable onPress={onPasteInvite} accessibilityRole="button" style={{ alignItems: 'center', paddingVertical: 2 }}>
                  <Text style={{ fontSize: 13, color: colors.textMuted }}>
                    Have an invite? <Text style={{ color: colors.accent, fontWeight: '600' }}>Paste it</Text>
                  </Text>
                </Pressable>
              ) : null}
              <Pressable onPress={onBrowseEvents} accessibilityRole="button" style={{ alignItems: 'center', paddingVertical: 2 }}>
                <Text style={{ fontSize: 12.5, color: colors.textMuted }}>
                  Or RSVP to events without an account
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </View>

      {/* Step 2 — Join your center */}
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <StepDot index={2} state={step2} colors={colors} />
        <View style={{ flex: 1 }}>
          <Text
            style={{
              fontSize: 14.5,
              color: step2 === 'todo' ? colors.textMuted : colors.text,
              fontWeight: step2 === 'active' ? '600' : '400',
            }}
          >
            Join your center
          </Text>

          {step2 === 'active' ? (
            <View style={{ marginTop: 10, gap: 8 }}>
              <CenterSearch
                colors={colors}
                dense
                placeholder="Enter your city or town"
                busyCenterId={joiningId}
                onSelect={(center) => handleJoin(center.id)}
              />
              <Pressable onPress={onBrowseEvents} accessibilityRole="button" style={{ paddingTop: 2 }}>
                <Text style={{ fontSize: 12.5, color: colors.textMuted }}>
                  Or RSVP to an event to see its board.
                </Text>
              </Pressable>
            </View>
          ) : (
            <Text style={{ fontSize: 12.5, lineHeight: 17, color: colors.textFaint, marginTop: 2 }}>
              Your home center's board lands here once you join.
            </Text>
          )}
        </View>
      </View>
    </View>
  )
}

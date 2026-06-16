import React from 'react'
import { View, Text, Pressable, useWindowDimensions, Linking } from 'react-native'
import { useRouter } from 'expo-router'
import { usePostHog } from 'posthog-react-native'

const CONTACT_EMAIL = 'projectjanatha@gmail.com'

interface AskCardProps {
  audience: string
  headline: string
  description: string
  ctaLabel: string
  onPress: () => void
  isMobile: boolean
}

function AskCard({
  audience,
  headline,
  description,
  ctaLabel,
  onPress,
  isMobile,
}: AskCardProps) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: '#FFFFFF',
        borderRadius: 20,
        padding: isMobile ? 24 : 28,
        borderWidth: 1,
        borderColor: '#F5F0EB',
        boxShadow: '0 2px 24px rgba(0,0,0,0.04)',
        gap: 14,
        justifyContent: 'space-between',
      }}
    >
      <View style={{ gap: 14 }}>
        <Text
          style={{
            fontFamily: 'Inclusive Sans, sans-serif',
            fontWeight: '600',
            fontSize: 11,
            letterSpacing: 1.5,
            textTransform: 'uppercase',
            color: '#C2410C',
          }}
        >
          {audience}
        </Text>
        <Text
          style={{
            fontFamily: '"Inclusive Sans", sans-serif',
            fontWeight: '400',
            fontSize: isMobile ? 22 : 24,
            lineHeight: isMobile ? 28 : 30,
            color: '#1C1917',
          }}
        >
          {headline}
        </Text>
        <Text
          style={{
            fontFamily: 'Inclusive Sans, sans-serif',
            fontSize: isMobile ? 14 : 15,
            lineHeight: isMobile ? 22 : 24,
            color: '#57534E',
          }}
        >
          {description}
        </Text>
      </View>

      <Pressable
        onPress={onPress}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingTop: 6,
        }}
      >
        <Text
          style={{
            fontFamily: 'Inclusive Sans, sans-serif',
            fontWeight: '600',
            fontSize: 14,
            color: '#C2410C',
          }}
        >
          {ctaLabel}
        </Text>
        <Text
          style={{
            fontFamily: 'Inclusive Sans, sans-serif',
            fontWeight: '600',
            fontSize: 14,
            color: '#C2410C',
          }}
        >
          →
        </Text>
      </Pressable>
    </View>
  )
}

export function FinalCTA() {
  const router = useRouter()
  const posthog = usePostHog()
  const { width } = useWindowDimensions()
  const isMobile = width < 768
  const isTablet = width >= 768 && width < 1024

  const openMail = (subject: string) => {
    const body = encodeURIComponent('Hari Om,\n\n')
    Linking.openURL(`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${body}`)
  }

  return (
    <View
      style={{
        paddingHorizontal: isMobile ? 20 : isTablet ? 40 : 80,
        paddingVertical: isMobile ? 60 : isTablet ? 80 : 100,
        backgroundColor: '#FAFAF7',
      }}
    >
      <View
        style={{
          backgroundColor: '#F5F0EB',
          borderRadius: 28,
          paddingHorizontal: isMobile ? 24 : isTablet ? 40 : 64,
          paddingVertical: isMobile ? 48 : isTablet ? 60 : 72,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {/* Subtle radial gradient */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background:
              'radial-gradient(ellipse at 50% 0%, rgba(194,65,12,0.08) 0%, transparent 70%)',
            pointerEvents: 'none',
          }}
        />

        {/* Header */}
        <View style={{ alignItems: 'center', marginBottom: isMobile ? 36 : 48 }}>
          <Text
            style={{
              fontFamily: 'Inclusive Sans, sans-serif',
              fontWeight: '600',
              fontSize: 12,
              letterSpacing: 1.5,
              textTransform: 'uppercase',
              color: '#C2410C',
              marginBottom: 16,
            }}
          >
            THE ASK
          </Text>
          <Text
            style={{
              fontFamily: '"Inclusive Sans", sans-serif',
              fontWeight: '400',
              fontSize: isMobile ? 32 : isTablet ? 40 : 48,
              lineHeight: isMobile ? 40 : isTablet ? 48 : 56,
              color: '#1C1917',
              textAlign: 'center',
              marginBottom: 16,
              maxWidth: 720,
            }}
          >
            All we're missing is you.
          </Text>
          <Text
            style={{
              fontFamily: 'Inclusive Sans, sans-serif',
              fontWeight: '400',
              fontSize: isMobile ? 16 : 18,
              lineHeight: isMobile ? 24 : 28,
              color: '#78716C',
              textAlign: 'center',
              maxWidth: 560,
            }}
          >
            The app is live. The community is ready. We need a few people from each corner of the
            Mission to help bring it to life.
          </Text>
        </View>

        {/* Three asks */}
        <View
          style={{
            flexDirection: isMobile ? 'column' : 'row',
            gap: isMobile ? 16 : 20,
            marginBottom: isMobile ? 36 : 44,
          }}
        >
          <AskCard
            audience="If you coordinate events"
            headline="Post your next event on Janata."
            description="It takes a minute per event, and CHYKs who aren't in your WhatsApp group can finally find you. We'll personally help you migrate your RSVP flow."
            ctaLabel="Get set up"
            onPress={() => {
              posthog?.capture('landing_ask_pressed', { audience: 'coordinator' })
              openMail('Coordinator — getting set up on Janata')
            }}
            isMobile={isMobile}
          />
          <AskCard
            audience="If you want to contribute"
            headline="Join the team."
            description="Volunteer-led across dev, design, product, and outreach. Async over Slack, as much or as little time as you can give. A great opportunity for seva."
            ctaLabel="Get in touch"
            onPress={() => {
              posthog?.capture('landing_ask_pressed', { audience: 'contributor' })
              openMail('Joining the Janata team')
            }}
            isMobile={isMobile}
          />
          <AskCard
            audience="If you're an acharya"
            headline="Bless this & introduce us."
            description="Designed to be run entirely by CHYKs — nothing added to your plate. Connect us with the coordinators at your center and spread the word to your CHYKs."
            ctaLabel="Connect with us"
            onPress={() => {
              posthog?.capture('landing_ask_pressed', { audience: 'acharya' })
              openMail('Acharya introduction — Janata')
            }}
            isMobile={isMobile}
          />
        </View>

        {/* Fallback CTA for casual visitors */}
        <View
          style={{
            alignItems: 'center',
            gap: 14,
            borderTopWidth: 1,
            borderTopColor: 'rgba(194,65,12,0.12)',
            paddingTop: isMobile ? 28 : 32,
          }}
        >
          <Text
            style={{
              fontFamily: 'Inclusive Sans, sans-serif',
              fontSize: 14,
              color: '#78716C',
            }}
          >
            Just here to look around?
          </Text>
          <Pressable
            onPress={() => {
              posthog?.capture('landing_cta_pressed', { variant: 'final', label: 'browse_events' })
              router.push('/explore')
            }}
            className="bg-primary active:bg-primary-press rounded-full"
            style={{
              paddingHorizontal: 28,
              paddingVertical: 12,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Text
              style={{
                fontFamily: 'Inclusive Sans, sans-serif',
                fontWeight: '500',
                fontSize: 15,
                color: '#FFFFFF',
              }}
            >
              Browse events nearby →
            </Text>
          </Pressable>
          <Text
            style={{
              fontFamily: 'Inclusive Sans, sans-serif',
              fontSize: 12,
              color: '#A8A29E',
            }}
          >
            Currently in beta · Available on web
          </Text>
        </View>
      </View>
    </View>
  )
}

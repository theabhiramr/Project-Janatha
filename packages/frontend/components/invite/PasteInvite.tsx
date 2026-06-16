import { useCallback } from 'react'
import { View, Text, Pressable } from 'react-native'
import { useRouter } from 'expo-router'
import { useColors } from '../../hooks/useColors'
import InviteCodeField from './InviteCodeField'

type PasteInviteProps = {
  /** Headline — neutral ("Have an invite?") or error ("This invite isn't active"). */
  title: string
  /** Supporting line under the headline. */
  subtitle: string
  /** Show the "No invite? Browse events" escape (neutral entry only). */
  showBrowse?: boolean
}

/**
 * Shared paste-an-invite block (new-25). Used as the neutral entry screen
 * (`/join`) and, with error copy, as Door 1's dead-code recovery (new-04).
 * Takes a pasted link or bare code, normalizes it, and routes to Door 1 so the
 * one resolver decides valid / invalid / already-a-member. RN primitives only,
 * so the same component renders on web and native.
 */
export default function PasteInvite({ title, subtitle, showBrowse }: PasteInviteProps) {
  const c = useColors()
  const router = useRouter()

  const open = useCallback((code: string) => {
    router.replace(`/i/${encodeURIComponent(code)}` as never)
  }, [router])

  return (
    <View style={{ width: '100%', maxWidth: 440, alignItems: 'center', gap: 16 }}>
      <View style={{ gap: 6, alignItems: 'center' }}>
        <Text
          style={{ fontFamily: 'Inclusive Sans', fontSize: 26, color: c.text, textAlign: 'center' }}
        >
          {title}
        </Text>
        <Text style={{ fontSize: 15, color: c.textMuted, textAlign: 'center', lineHeight: 22 }}>
          {subtitle}
        </Text>
      </View>

      <InviteCodeField onSubmit={open} />

      {showBrowse && (
        <Pressable onPress={() => router.replace('/(tabs)')} style={{ paddingVertical: 8 }}>
          <Text style={{ color: c.textMuted, fontSize: 14 }}>
            No invite? <Text style={{ color: c.accent, fontWeight: '600' }}>Browse events</Text>
          </Text>
        </Pressable>
      )}
    </View>
  )
}

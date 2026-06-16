import { useEffect } from 'react'
import { View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useColors } from '../hooks/useColors'
import { extractInviteCode } from '../utils/validation'
import PasteInvite from '../components/invite/PasteInvite'
import Logo from '../components/ui/Logo'

/**
 * /join — neutral "Have an invite?" paste screen (new-25). The target of every
 * "Have an invite?" affordance. Takes a link or bare code and hands off to
 * Door 1 (`/i/[code]`), the single resolver.
 *
 * Also catches legacy `chinmayajanata.org/join?code=CODE` links: if a `code`
 * param is present, skip the paste step and go straight to Door 1.
 */
export default function JoinScreen() {
  const c = useColors()
  const router = useRouter()
  const { code: raw } = useLocalSearchParams<{ code?: string }>()
  const legacyCode = extractInviteCode(typeof raw === 'string' ? raw : '')

  useEffect(() => {
    if (legacyCode) router.replace(`/i/${encodeURIComponent(legacyCode)}`)
  }, [legacyCode, router])

  if (legacyCode) return <View style={{ flex: 1, backgroundColor: c.bg }} />

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: c.bg,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
      }}
    >
      <View style={{ width: '100%', maxWidth: 440, alignItems: 'center', gap: 34 }}>
        <Logo size={32} />
        <PasteInvite
          title="Welcome"
          subtitle="Paste your invite link or code to continue."
          showBrowse
        />
      </View>
    </View>
  )
}

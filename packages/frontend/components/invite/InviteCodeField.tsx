import { useCallback, useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'
import { useColors } from '../../hooks/useColors'
import { extractInviteCode } from '../../utils/validation'

type InviteCodeInputProps = {
  value: string
  onChangeText: (value: string) => void
  error?: string
  helperText?: string
  compact?: boolean
  onSubmitEditing?: () => void
}

type InviteCodeFieldProps = {
  onSubmit: (code: string) => void
  buttonLabel?: string
  helperText?: string
  compact?: boolean
}

export function InviteCodeInput({
  value,
  onChangeText,
  error,
  helperText = 'Paste the full invite link or just the code.',
  compact = false,
  onSubmitEditing,
}: InviteCodeInputProps) {
  const c = useColors()

  return (
    <View style={{ width: '100%', gap: compact ? 6 : 8 }}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder="Invite link or code"
        placeholderTextColor={c.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        onSubmitEditing={onSubmitEditing}
        style={{
          width: '100%',
          minHeight: compact ? 46 : 48,
          backgroundColor: c.surface,
          borderWidth: 1,
          borderColor: error ? c.error : c.border,
          borderRadius: 12,
          paddingVertical: 11,
          paddingHorizontal: 14,
          fontSize: 16,
          fontFamily: 'Inclusive Sans',
          color: c.text,
        }}
      />
      <Text
        style={{
          fontSize: 13,
          lineHeight: 18,
          fontFamily: 'Inclusive Sans',
          color: error ? c.error : c.textMuted,
        }}
      >
        {error || helperText}
      </Text>
    </View>
  )
}

export default function InviteCodeField({
  onSubmit,
  buttonLabel = 'Open invite',
  helperText,
  compact = false,
}: InviteCodeFieldProps) {
  const c = useColors()
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const hasText = value.trim().length > 0

  const open = useCallback(() => {
    const code = extractInviteCode(value)
    if (!code) {
      setError('Paste a valid invite link or code.')
      return
    }
    setError('')
    onSubmit(code)
  }, [onSubmit, value])

  return (
    <View style={{ width: '100%', gap: compact ? 8 : 10 }}>
      <InviteCodeInput
        value={value}
        onChangeText={(next) => {
          setValue(next)
          if (error) setError('')
        }}
        onSubmitEditing={open}
        error={error}
        helperText={helperText}
        compact={compact}
      />
      <Pressable
        onPress={open}
        disabled={!hasText}
        accessibilityRole="button"
        style={({ pressed }) => ({
          minHeight: compact ? 44 : 48,
          borderRadius: 12,
          backgroundColor: !hasText ? c.surface : pressed ? c.accentPress : c.accent,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: hasText ? 1 : 0.7,
        })}
      >
        <Text
          style={{
            color: hasText ? c.textInverse : c.textFaint,
            fontSize: 15,
            fontFamily: 'Inclusive Sans',
            fontWeight: '600',
          }}
        >
          {buttonLabel}
        </Text>
      </Pressable>
    </View>
  )
}

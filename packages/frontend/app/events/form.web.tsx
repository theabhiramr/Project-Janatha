import React, { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  ScrollView,
  TextInput,
  Pressable,
  ActivityIndicator,
  Switch,
  useWindowDimensions,
  Image,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronLeft, ChevronDown, ImagePlus } from 'lucide-react-native'
import { useAnalytics } from '../../utils/analytics'
import { useTheme } from '../../components/contexts'
import { useDetailColors, type DetailColors } from '../../hooks/useDetailColors'
import { PrimaryButton, SecondaryButton } from '../../components/ui'
import {
  fetchEvent,
  fetchCenters,
  createEvent,
  updateEvent,
  uploadBoardImage,
  type CenterData,
} from '../../utils/api'

const todayLocalISODate = (): string => {
  const d = new Date()
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}


const CATEGORY_OPTIONS = [
  { value: undefined, label: 'None' },
  { value: 91, label: 'Satsang' },
  { value: 92, label: 'Bhiksha' },
]

// ── Field row ────────────────────────────────────────────────────────────

function FieldRow({
  label,
  colors,
  error,
  required,
  hint,
  children,
}: {
  label: string
  colors: DetailColors
  error?: string
  required?: boolean
  hint?: string
  children: React.ReactNode
}) {
  return (
    <View style={{ gap: 6 }}>
      <Text
        style={{
          fontFamily: 'Inclusive Sans',
          fontSize: 11,
          color: colors.textMuted,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
        }}
      >
        {label}
        {required ? <Text style={{ color: '#E8862A' }}> *</Text> : null}
      </Text>
      {hint && !error ? (
        <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 12, color: colors.textMuted }}>
          {hint}
        </Text>
      ) : null}
      {children}
      {error ? (
        <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 12, color: '#DC2626' }}>
          {error}
        </Text>
      ) : null}
    </View>
  )
}

function NativeDateTimeInput({
  type,
  value,
  onChange,
  min,
  hasError,
  colors,
  isDark,
}: {
  type: 'date' | 'time' | 'datetime-local'
  value: string
  onChange: (v: string) => void
  min?: string
  hasError?: boolean
  colors: DetailColors
  isDark?: boolean
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      min={min}
      style={{
        fontFamily: 'Inclusive Sans, -apple-system, sans-serif',
        fontSize: 15,
        color: colors.text,
        padding: '12px 14px',
        borderRadius: 10,
        border: `1px solid ${hasError ? '#DC2626' : colors.border}`,
        backgroundColor: colors.cardBg,
        outline: 'none',
        boxSizing: 'border-box',
        width: '100%',
        colorScheme: isDark ? 'dark' : 'light',
      }}
    />
  )
}

// ── Main component ──────────────────────────────────────────────────────

export default function EventFormPage() {
  const params = useLocalSearchParams<{ id?: string }>()
  const eventId = params.id
  const isEdit = !!eventId
  const router = useRouter()
  const colors = useDetailColors()
  const { track } = useAnalytics()
  const { isDark } = useTheme()
  const today = todayLocalISODate()
  const { width: viewportWidth } = useWindowDimensions()

  const isNarrow = viewportWidth < 768

  const [loading, setLoading] = useState(isEdit)
  const [saving, setSaving] = useState(false)
  const [centers, setCenters] = useState<CenterData[]>([])
  const [showCenterPicker, setShowCenterPicker] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Form state
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [address, setAddress] = useState('')
  const [latitude, setLatitude] = useState('')
  const [longitude, setLongitude] = useState('')
  const [centerID, setCenterID] = useState('')
  const [centerName, setCenterName] = useState('')
  const [pointOfContact, setPointOfContact] = useState('')
  const [image, setImage] = useState('')
  const [category, setCategory] = useState<number | undefined>(undefined)
  const [externalUrl, setExternalUrl] = useState('')
  const [signupUrl, setSignupUrl] = useState('')
  const [allowJanataSignup, setAllowJanataSignup] = useState(true)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [uploadingImage, setUploadingImage] = useState(false)

  // Pick + upload an event photo (web), reusing the board image upload (R2).
  const pickEventImage = () => {
    if (typeof document === 'undefined') return
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        setUploadingImage(true)
        const url = await uploadBoardImage(file)
        setImage(url)
        track('event_form_image_uploaded', { source: 'event_form' })
      } catch {
        setErrors((e) => ({ ...e, image: 'Upload failed. Please try again.' }))
      } finally {
        setUploadingImage(false)
      }
    }
    input.click()
  }


  useEffect(() => {
    let mounted = true

    const load = async () => {
      try {
        const allCenters = await fetchCenters()
        if (!mounted) return
        setCenters(allCenters)

        if (isEdit && eventId) {
          const event = await fetchEvent(eventId)
          if (!mounted) return

          if (event) {
            setTitle(event.title || '')
            setDescription(event.description || '')

            if (event.date) {
              const d = new Date(event.date)
              const yyyy = d.getFullYear()
              const mm = String(d.getMonth() + 1).padStart(2, '0')
              const dd = String(d.getDate()).padStart(2, '0')
              const hh = String(d.getHours()).padStart(2, '0')
              const mi = String(d.getMinutes()).padStart(2, '0')
              setDate(`${yyyy}-${mm}-${dd}`)
              setTime(`${hh}:${mi}`)
            }

            setAddress(event.address || '')
            setLatitude(event.latitude != null ? String(event.latitude) : '')
            setLongitude(event.longitude != null ? String(event.longitude) : '')
            setCenterID(event.centerID || '')
            setPointOfContact(event.pointOfContact || '')
            setImage(event.image || '')
            setCategory(event.category ?? undefined)
            setExternalUrl(event.externalUrl || '')
            setSignupUrl(event.signupUrl || '')
            setAllowJanataSignup(event.allowJanataSignup ?? true)

            const matchingCenter = allCenters.find((c) => c.centerID === event.centerID)
            if (matchingCenter) setCenterName(matchingCenter.name)
          }
        }
      } catch (err) {
        if (__DEV__) console.warn('[EventForm]', err)
      } finally {
        if (mounted) setLoading(false)
      }
    }

    load()
    return () => { mounted = false }
  }, [eventId, isEdit])

  const validate = useCallback((): boolean => {
    const newErrors: Record<string, string> = {}

    if (!title.trim()) newErrors.title = 'Title is required'
    if (!date.trim()) newErrors.date = 'Date is required'
    if (!centerID) newErrors.center = 'Center is required'

    if (date && !newErrors.date) {
      // If time is missing, treat as end-of-day so today still passes the future-check
      const eventDateTime = new Date(`${date}T${time || '23:59'}:00`)
      if (!isNaN(eventDateTime.getTime()) && eventDateTime <= new Date()) {
        if (date < today) {
          newErrors.date = 'Date must be today or later'
        } else {
          newErrors.time = 'Time must be in the future'
        }
      }
    }

    const lat = parseFloat(latitude)
    const lng = parseFloat(longitude)
    if (!latitude || isNaN(lat) || lat < -90 || lat > 90) {
      newErrors.latitude = 'Valid latitude required (-90 to 90)'
    }
    if (!longitude || isNaN(lng) || lng < -180 || lng > 180) {
      newErrors.longitude = 'Valid longitude required (-180 to 180)'
    }

    setErrors(newErrors)
    if (newErrors.latitude || newErrors.longitude) setShowAdvanced(true)
    return Object.keys(newErrors).length === 0
  }, [title, date, time, centerID, latitude, longitude, today])

  const buildDateISO = (): string => {
    if (!time.trim()) return `${date}T12:00:00`
    return `${date}T${time}:00`
  }

  const handleSave = async () => {
    if (!validate()) return
    setSaving(true)

    try {
      const sharedFields = {
        title: title.trim(),
        description: description.trim(),
        date: buildDateISO(),
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        address: address.trim() || undefined,
        centerID,
        pointOfContact: pointOfContact.trim() || undefined,
        image: image.trim() || undefined,
        category,
        externalUrl: externalUrl.trim() || null,
        signupUrl: signupUrl.trim() || null,
        // Toggle is only meaningful when there's an external signup URL.
        // Without one, native signups are always on.
        allowJanataSignup: signupUrl.trim() ? allowJanataSignup : true,
      }
      if (isEdit && eventId) {
        await updateEvent({ id: eventId, ...sharedFields })
        track('event_updated', { eventId, title: title.trim(), source: 'event_form' })
        router.replace(`/events/${eventId}`)
      } else {
        const created = await createEvent(sharedFields)
        track('event_created', { title: title.trim(), centerID, source: 'event_form' })
        router.replace(`/events/${created.id}`)
      }
    } catch (err: any) {
      const msg = err?.message || 'Something went wrong. Please try again.'
      track('event_create_failed', { error: msg, isEdit, source: 'event_form' })
      setErrors({ submit: msg })
    } finally {
      setSaving(false)
    }
  }

  const selectCenter = (center: CenterData) => {
    setCenterID(center.centerID)
    setCenterName(center.name)
    if (!latitude && center.latitude) setLatitude(String(center.latitude))
    if (!longitude && center.longitude) setLongitude(String(center.longitude))
    if (!address && center.address) setAddress(center.address)
    setShowCenterPicker(false)
    track('event_form_center_selected', { centerID: center.centerID, centerName: center.name, source: 'event_form' })
  }

  const inputStyle = (hasError?: boolean) => ({
    fontFamily: 'Inclusive Sans' as const,
    fontSize: 15,
    color: colors.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: hasError ? '#DC2626' : colors.border,
    backgroundColor: colors.cardBg,
  })

  // ── Loading ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.panelBg, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color="#E8862A" />
      </View>
    )
  }

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <View style={{ flex: 1, backgroundColor: colors.panelBg }}>
      {/* Header */}
      <View
        style={{
          paddingHorizontal: isNarrow ? 16 : 40,
          paddingTop: 20,
          paddingBottom: 16,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          maxWidth: 900,
          width: '100%',
          alignSelf: 'center',
        }}
      >
        <View style={{ gap: 4 }}>
          <Pressable
            onPress={() => { track('event_form_back_pressed', { isEdit, source: 'event_form' }); router.back() }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 8 }}
          >
            <ChevronLeft size={18} color={colors.iconHeader} />
            <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 14, color: colors.iconHeader }}>
              Back
            </Text>
          </Pressable>
          <Text style={{ fontFamily: 'Inclusive Sans', fontSize: isNarrow ? 22 : 28, color: colors.text, letterSpacing: -0.5 }}>
            {isEdit ? 'Edit Event' : 'Create Event'}
          </Text>
          <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 14, color: colors.textMuted, marginTop: 2 }}>
            {isEdit
              ? 'Update event details below'
              : 'Fill in the details to create a new event. Fields marked * are required.'}
          </Text>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          maxWidth: 900,
          width: '100%',
          alignSelf: 'center',
          padding: isNarrow ? 20 : 40,
          gap: 24,
          paddingBottom: 120,
        }}
        showsVerticalScrollIndicator={false}
      >
        {errors.submit ? (
          <View
            style={{
              padding: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: '#DC2626',
              backgroundColor: 'rgba(220,38,38,0.08)',
            }}
          >
            <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 13, color: '#DC2626' }}>
              {errors.submit}
            </Text>
          </View>
        ) : null}

        {/* Title */}
        <FieldRow label="Title" colors={colors} error={errors.title} required>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="e.g. Sunday Satsang with Swamiji"
            placeholderTextColor={colors.textMuted}
            style={inputStyle(!!errors.title)}
          />
        </FieldRow>

        {/* Description */}
        <FieldRow label="Description" colors={colors} hint="What will attendees experience? Speakers, agenda, what to bring.">
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="Describe the event..."
            placeholderTextColor={colors.textMuted}
            multiline
            textAlignVertical="top"
            style={{
              ...inputStyle(),
              minHeight: 120,
            }}
          />
        </FieldRow>

        {/* Date & time */}
        <FieldRow label="Date & time" colors={colors} error={errors.date || errors.time} required>
          <NativeDateTimeInput
            type="datetime-local"
            value={date ? `${date}T${time || '12:00'}` : ''}
            onChange={(value) => {
              const [nextDate, nextTime = ''] = value.split('T')
              setDate(nextDate)
              setTime(nextTime.slice(0, 5))
            }}
            min={`${today}T00:00`}
            hasError={!!errors.date || !!errors.time}
            colors={colors}
            isDark={isDark}
          />
        </FieldRow>

        {/* Center selection */}
        <FieldRow label="Center" colors={colors} error={errors.center} required hint="Picking a center auto-fills address & coordinates.">
          <Pressable
            onPress={() => { const next = !showCenterPicker; setShowCenterPicker(next); if (next) track('event_form_center_picker_opened', { source: 'event_form' }) }}
            style={{
              ...inputStyle(!!errors.center),
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Text
              style={{
                fontFamily: 'Inclusive Sans',
                fontSize: 15,
                color: centerName ? colors.text : colors.textMuted,
              }}
            >
              {centerName || 'Select a center...'}
            </Text>
            <ChevronDown
              size={16}
              color={colors.textMuted}
              style={{ transform: [{ rotate: showCenterPicker ? '180deg' : '0deg' }] }}
            />
          </Pressable>

          {showCenterPicker && (
            <View
              style={{
                marginLeft: 42,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.cardBg,
                maxHeight: 200,
                overflow: 'hidden',
              }}
            >
              <ScrollView nestedScrollEnabled showsVerticalScrollIndicator>
                {centers.map((center) => (
                  <Pressable
                    key={center.centerID}
                    onPress={() => selectCenter(center)}
                    style={{
                      paddingHorizontal: 14,
                      paddingVertical: 12,
                      borderBottomWidth: 1,
                      borderBottomColor: colors.border,
                      backgroundColor: center.centerID === centerID ? 'rgba(232,134,42,0.1)' : 'transparent',
                    }}
                  >
                    <Text
                      style={{
                        fontFamily: center.centerID === centerID ? 'Inclusive Sans' : 'Inclusive Sans',
                        fontSize: 14,
                        color: center.centerID === centerID ? '#E8862A' : colors.text,
                      }}
                    >
                      {center.name}
                    </Text>
                    {center.address ? (
                      <Text
                        style={{
                          fontFamily: 'Inclusive Sans',
                          fontSize: 12,
                          color: colors.textSecondary,
                          marginTop: 2,
                        }}
                      >
                        {center.address}
                      </Text>
                    ) : null}
                  </Pressable>
                ))}
                {centers.length === 0 && (
                  <View style={{ paddingHorizontal: 14, paddingVertical: 16, alignItems: 'center' }}>
                    <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 13, color: colors.textMuted }}>
                      No centers available
                    </Text>
                  </View>
                )}
              </ScrollView>
            </View>
          )}
        </FieldRow>

        {/* Image — upload a photo or paste a URL */}
        <FieldRow label="Image" colors={colors} error={errors.image} hint="Optional. Upload a photo or paste a direct link.">
          {image.trim() ? (
            <Image
              source={{ uri: image }}
              style={{ width: '100%', height: 160, borderRadius: 12, backgroundColor: colors.iconBoxBg, marginBottom: 8 }}
              resizeMode="cover"
            />
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <Pressable
              onPress={pickEventImage}
              disabled={uploadingImage}
              accessibilityRole="button"
              style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.cardBg }}
            >
              {uploadingImage ? <ActivityIndicator size="small" color="#E8862A" /> : <ImagePlus size={16} color="#E8862A" />}
              <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 13, color: colors.text }}>
                {uploadingImage ? 'Uploading…' : image ? 'Replace photo' : 'Upload photo'}
              </Text>
            </Pressable>
            {image ? (
              <Pressable onPress={() => setImage('')} accessibilityRole="button" style={{ paddingVertical: 10, paddingHorizontal: 6 }}>
                <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 13, color: colors.textMuted }}>Remove</Text>
              </Pressable>
            ) : null}
          </View>
        </FieldRow>

        {/* Category */}
        <FieldRow label="Category" colors={colors}>
          <View style={{ flexDirection: 'row', gap: 8, marginLeft: 42, flexWrap: 'wrap' }}>
            {CATEGORY_OPTIONS.map((opt) => {
              const selected = category === opt.value
              return (
                <Pressable
                  key={opt.label}
                  onPress={() => { setCategory(opt.value); track('event_form_category_selected', { category: opt.label, value: opt.value ?? null, source: 'event_form' }) }}
                  style={{
                    paddingHorizontal: 18,
                    paddingVertical: 10,
                    borderRadius: 100,
                    minHeight: 40,
                    justifyContent: 'center',
                    backgroundColor: selected ? '#E8862A' : colors.iconBoxBg,
                  }}
                >
                  <Text
                    style={{
                      fontFamily: selected ? 'Inclusive Sans' : 'Inclusive Sans',
                      fontSize: 13,
                      color: selected ? '#FFFFFF' : colors.textSecondary,
                    }}
                  >
                    {opt.label}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        </FieldRow>

        {/* Advanced: coordinates (collapsed by default — auto-filled from center) */}
        <View style={{ gap: 12, marginTop: 4 }}>
          <Pressable
            onPress={() => setShowAdvanced((v) => { const next = !v; track('event_form_advanced_toggled', { expanded: next, source: 'event_form' }); return next })}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
            accessibilityLabel="Toggle advanced location options"
          >
            <ChevronDown
              size={14}
              color={colors.textMuted}
              style={{ transform: [{ rotate: showAdvanced ? '0deg' : '-90deg' }] }}
            />
            <Text
              style={{
                fontFamily: 'Inclusive Sans',
                fontSize: 12,
                color: colors.textMuted,
                letterSpacing: 0.4,
                textTransform: 'uppercase',
              }}
            >
              Advanced options
            </Text>
            {(errors.latitude || errors.longitude) ? (
              <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 12, color: '#DC2626' }}>
                · check coordinates
              </Text>
            ) : null}
          </Pressable>
          {showAdvanced && (
            <>
            <FieldRow label="Address" colors={colors} hint="Where the event is held. Auto-filled from center if blank.">
              <TextInput value={address} onChangeText={setAddress} placeholder="123 Main St, City, ST 12345" placeholderTextColor={colors.textMuted} style={inputStyle()} />
            </FieldRow>
            <FieldRow label="Point of Contact" colors={colors} hint="Optional. Email or name attendees can reach.">
              <TextInput value={pointOfContact} onChangeText={setPointOfContact} placeholder="contact@example.org" placeholderTextColor={colors.textMuted} style={inputStyle()} />
            </FieldRow>
            <FieldRow label="External info link" colors={colors} hint="Optional. Page about the event on another site (e.g., chinmayamission.com).">
              <TextInput value={externalUrl} onChangeText={setExternalUrl} placeholder="https://..." placeholderTextColor={colors.textMuted} autoCapitalize="none" style={inputStyle()} />
            </FieldRow>
            <FieldRow label="External signup URL" colors={colors} hint="Optional. If attendees register on another site (Eventbrite, Google Form, etc.).">
              <TextInput value={signupUrl} onChangeText={setSignupUrl} placeholder="https://..." placeholderTextColor={colors.textMuted} autoCapitalize="none" style={inputStyle()} />
              {signupUrl.trim() ? (
                <View style={{ marginTop: 10, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.cardBg, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 14, color: colors.text }}>Also accept Janata RSVPs</Text>
                    <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 12, color: colors.textMuted, marginTop: 2 }}>When off, the only signup option is the link above.</Text>
                  </View>
                  <Switch value={allowJanataSignup} onValueChange={(v) => { setAllowJanataSignup(v); track('event_form_janata_signup_toggled', { enabled: v, source: 'event_form' }) }} trackColor={{ true: '#E8862A', false: colors.border }} thumbColor="#FFFFFF" ios_backgroundColor={colors.border} />
                </View>
              ) : null}
            </FieldRow>
            <FieldRow label="Coordinates" colors={colors} error={errors.latitude || errors.longitude} hint="Auto-filled when you pick a center. Override only if pin is wrong.">
              <View style={{ flexDirection: 'row', gap: 10, marginLeft: 42 }}>
                <TextInput
                  value={latitude}
                  onChangeText={setLatitude}
                  placeholder="Latitude"
                  placeholderTextColor={colors.textMuted}
                  style={{
                    ...inputStyle(!!errors.latitude),
                    marginLeft: 0,
                    flex: 1,
                  }}
                />
                <TextInput
                  value={longitude}
                  onChangeText={setLongitude}
                  placeholder="Longitude"
                  placeholderTextColor={colors.textMuted}
                  style={{
                    ...inputStyle(!!errors.longitude),
                    marginLeft: 0,
                    flex: 1,
                  }}
                />
              </View>
            </FieldRow>
            </>
          )}
        </View>
      </ScrollView>

      {/* Sticky action bar */}
      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: colors.border,
          padding: 16,
          paddingHorizontal: isNarrow ? 16 : 40,
          backgroundColor: colors.panelBg,
          flexDirection: 'row',
          justifyContent: 'flex-end',
          gap: 12,
          maxWidth: 900,
          width: '100%',
          alignSelf: 'center',
        }}
      >
        <SecondaryButton
          onPress={() => { track('event_form_back_pressed', { isEdit, source: 'event_form' }); router.back() }}
          style={{ paddingHorizontal: 24, paddingVertical: 12 }}
        >
          Cancel
        </SecondaryButton>
        <PrimaryButton
          onPress={handleSave}
          disabled={saving}
          loading={saving}
          style={{ paddingHorizontal: 32, paddingVertical: 12 }}
        >
          {isEdit ? 'Save Changes' : 'Create Event'}
        </PrimaryButton>
      </View>
    </View>
  )
}

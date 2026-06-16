import React, { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, TextInput, Pressable, ActivityIndicator, Switch, Image } from 'react-native'
import { ChevronLeft, ChevronDown, ImagePlus } from 'lucide-react-native'
import { useDetailColors, type DetailColors } from '../../hooks/useDetailColors'
import { useTheme } from '../contexts'
import PrimaryButton from '../ui/buttons/PrimaryButton'
import SecondaryButton from '../ui/buttons/SecondaryButton'
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
  { value: undefined as number | undefined, label: 'None' },
  { value: 91, label: 'Satsang' },
  { value: 92, label: 'Bhiksha' },
]

// ── Types ────────────────────────────────────────────────────────────────

type EventFormPanelProps = {
  eventId?: string
  onClose: () => void
  onSaved?: (savedEventId: string) => void
}

// ── Input component ──────────────────────────────────────────────────────

function FormInput({
  value,
  onChangeText,
  placeholder,
  colors,
  hasError,
  multiline,
  style,
  ...rest
}: {
  value: string
  onChangeText: (text: string) => void
  placeholder: string
  colors: DetailColors
  hasError?: boolean
  multiline?: boolean
  style?: any
  [key: string]: any
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.textMuted}
      multiline={multiline}
      textAlignVertical={multiline ? 'top' : undefined}
      style={{
        fontFamily: 'Inclusive Sans',
        fontSize: 14,
        color: colors.text,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: hasError ? '#DC2626' : colors.border,
        backgroundColor: colors.cardBg,
        ...(multiline ? { minHeight: 100 } : {}),
        ...style,
      }}
      {...rest}
    />
  )
}

// ── Field label ──────────────────────────────────────────────────────────

function FieldLabel({
  label,
  colors,
  required,
  hint,
}: {
  label: string
  colors: DetailColors
  required?: boolean
  hint?: string
}) {
  return (
    <View style={{ marginBottom: 6, gap: 2 }}>
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
      {hint ? (
        <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 11, color: colors.textMuted }}>
          {hint}
        </Text>
      ) : null}
    </View>
  )
}

// ── Native HTML date / time inputs ───────────────────────────────────────

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
        fontSize: 14,
        color: colors.text,
        padding: '10px 12px',
        borderRadius: 8,
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

// ── Main component ───────────────────────────────────────────────────────

export default function EventFormPanel({ eventId, onClose, onSaved }: EventFormPanelProps) {
  const isEdit = !!eventId
  const colors = useDetailColors()
  const { isDark } = useTheme()
  const today = todayLocalISODate()

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

  // Pick + upload an event photo (web). Reuses the board image upload (R2);
  // sets the image URL field to the returned public URL.
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
        if (__DEV__) console.warn('[EventFormPanel]', err)
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
      // If time is missing, treat as end-of-day (so today still passes the future-check)
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
      newErrors.latitude = 'Valid latitude required'
    }
    if (!longitude || isNaN(lng) || lng < -180 || lng > 180) {
      newErrors.longitude = 'Valid longitude required'
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
        // Without one, native signups are always on, so default to true.
        allowJanataSignup: signupUrl.trim() ? allowJanataSignup : true,
      }
      let savedId = eventId
      if (isEdit && eventId) {
        await updateEvent({ id: eventId, ...sharedFields })
      } else {
        const created = await createEvent(sharedFields)
        savedId = created.id
      }
      if (savedId) onSaved?.(savedId)
    } catch (err: any) {
      setErrors({ submit: err?.message || 'Something went wrong. Please try again.' })
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
  }

  const errorText = (key: string) =>
    errors[key] ? (
      <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 11, color: '#DC2626', marginTop: 4 }}>
        {errors[key]}
      </Text>
    ) : null

  // ── Loading ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View
        style={{
          maxWidth: 440,
          width: '100%',
          height: '100%',
          backgroundColor: colors.panelBg,
          borderLeftWidth: 1,
          borderLeftColor: colors.border,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <ActivityIndicator size="large" color="#E8862A" />
      </View>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <View
      style={{
        maxWidth: 440,
        width: '100%',
        height: '100%',
        backgroundColor: colors.panelBg,
        borderLeftWidth: 1,
        borderLeftColor: colors.border,
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: 14,
          paddingBottom: 12,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
          gap: 10,
        }}
      >
        {/* Top row: back */}
        <View className="flex-row items-center" style={{ justifyContent: 'space-between' }}>
          <Pressable
            onPress={onClose}
            className="flex-row items-center"
            style={{ gap: 4, padding: 8, minHeight: 44, minWidth: 44 }}
            accessibilityLabel="Close panel"
          >
            <ChevronLeft size={20} color={colors.iconHeader} />
            <Text
              style={{
                fontFamily: 'Inclusive Sans',
                fontSize: 14,
                color: colors.iconHeader,
              }}
            >
              Back
            </Text>
          </Pressable>
        </View>

        {/* Title */}
        <Text
          style={{
            fontFamily: 'Inclusive Sans',
            fontSize: 20,
            color: colors.text,
            lineHeight: 26,
          }}
        >
          {isEdit ? 'Edit Event' : 'Create Event'}
        </Text>
        <Text
          style={{
            fontFamily: 'Inclusive Sans',
            fontSize: 13,
            color: colors.textSecondary,
          }}
        >
          {isEdit ? 'Update event details below' : 'Fill in the details for your new event'}
        </Text>
      </View>

      {/* Form body */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 20, gap: 20, paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Submit error banner (network / backend) */}
        {errors.submit ? (
          <View
            style={{
              padding: 12,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: '#DC2626',
              backgroundColor: 'rgba(220,38,38,0.08)',
            }}
          >
            <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 12, color: '#DC2626' }}>
              {errors.submit}
            </Text>
          </View>
        ) : null}

        {/* Title */}
        <View>
          <FieldLabel label="Title" colors={colors} required />
          <FormInput
            value={title}
            onChangeText={setTitle}
            placeholder="Sunday Satsang with Swamiji"
            colors={colors}
            hasError={!!errors.title}
          />
          {errorText('title')}
        </View>

        {/* Description */}
        <View>
          <FieldLabel label="Description" colors={colors} hint="What attendees will experience." />
          <FormInput
            value={description}
            onChangeText={setDescription}
            placeholder="Speakers, agenda, what to bring..."
            colors={colors}
            multiline
          />
        </View>

        {/* Date & time */}
        <View>
          <FieldLabel label="Date & time" colors={colors} required />
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
          {errorText('date')}
          {errorText('time')}
        </View>

        {/* Center */}
        <View>
          <FieldLabel label="Center" colors={colors} required hint="Picking a center auto-fills address & coordinates." />
          <Pressable
            onPress={() => setShowCenterPicker(!showCenterPicker)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: 12,
              paddingVertical: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: errors.center ? '#DC2626' : colors.border,
              backgroundColor: colors.cardBg,
            }}
          >
            <Text
              style={{
                fontFamily: 'Inclusive Sans',
                fontSize: 14,
                color: centerName ? colors.text : colors.textMuted,
              }}
            >
              {centerName || 'Select a center...'}
            </Text>
            <ChevronDown
              size={14}
              color={colors.textMuted}
              style={{ transform: [{ rotate: showCenterPicker ? '180deg' : '0deg' }] }}
            />
          </Pressable>
          {errorText('center')}

          {showCenterPicker && (
            <View
              style={{
                marginTop: 4,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.cardBg,
                maxHeight: 180,
                overflow: 'hidden',
              }}
            >
              <ScrollView nestedScrollEnabled showsVerticalScrollIndicator>
                {centers.map((center) => (
                  <Pressable
                    key={center.centerID}
                    onPress={() => selectCenter(center)}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      borderBottomWidth: 1,
                      borderBottomColor: colors.border,
                      backgroundColor:
                        center.centerID === centerID ? 'rgba(232,134,42,0.08)' : 'transparent',
                    }}
                  >
                    <Text
                      style={{
                        fontFamily: center.centerID === centerID ? 'Inclusive Sans' : 'Inclusive Sans',
                        fontSize: 13,
                        color: center.centerID === centerID ? '#E8862A' : colors.text,
                      }}
                    >
                      {center.name}
                    </Text>
                    {center.address ? (
                      <Text
                        style={{
                          fontFamily: 'Inclusive Sans',
                          fontSize: 11,
                          color: colors.textSecondary,
                          marginTop: 1,
                        }}
                      >
                        {center.address}
                      </Text>
                    ) : null}
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          )}
        </View>

        {/* Image — upload a photo or paste a URL */}
        <View>
          <FieldLabel label="Image" colors={colors} hint="Optional. Upload a photo or paste a direct link." />
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
          {errorText('image')}
        </View>

        {/* Advanced options — collapsed by default so the form isn't overwhelming.
            Address + point of contact auto-derive from the center; external links
            and coordinates are rarely needed. */}
        <View style={{ gap: 16 }}>
          <Pressable
            onPress={() => setShowAdvanced((v) => !v)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
            accessibilityLabel="Toggle advanced options"
          >
            <ChevronDown
              size={12}
              color={colors.textMuted}
              style={{ transform: [{ rotate: showAdvanced ? '0deg' : '-90deg' }] }}
            />
            <Text
              style={{
                fontFamily: 'Inclusive Sans',
                fontSize: 11,
                color: colors.textMuted,
                letterSpacing: 0.4,
                textTransform: 'uppercase',
              }}
            >
              Advanced options
            </Text>
            {(errors.latitude || errors.longitude) ? (
              <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 11, color: '#DC2626' }}>
                · check coordinates
              </Text>
            ) : null}
          </Pressable>

          {showAdvanced ? (
            <View style={{ gap: 18 }}>
              {/* Address */}
              <View>
                <FieldLabel label="Address" colors={colors} hint="Auto-filled from center if blank." />
                <FormInput value={address} onChangeText={setAddress} placeholder="123 Main St, City, ST 12345" colors={colors} />
              </View>

              {/* Point of Contact */}
              <View>
                <FieldLabel label="Point of Contact" colors={colors} hint="Optional. Email or name." />
                <FormInput value={pointOfContact} onChangeText={setPointOfContact} placeholder="contact@example.org" colors={colors} />
              </View>

              {/* External info link */}
              <View>
                <FieldLabel label="External info link" colors={colors} hint="Optional. Page about the event on another site (e.g., chinmayamission.com)." />
                <FormInput value={externalUrl} onChangeText={setExternalUrl} placeholder="https://..." colors={colors} autoCapitalize="none" />
              </View>

              {/* External signup URL + Janata-RSVP toggle */}
              <View>
                <FieldLabel label="External signup URL" colors={colors} hint="Optional. If attendees register on another site (Eventbrite, Google Form, etc.)." />
                <FormInput value={signupUrl} onChangeText={setSignupUrl} placeholder="https://..." colors={colors} autoCapitalize="none" />
                {signupUrl.trim() ? (
                  <View
                    style={{
                      marginTop: 10,
                      padding: 12,
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: colors.border,
                      backgroundColor: colors.cardBg,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 12,
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 13, color: colors.text }}>
                        Also accept Janata RSVPs
                      </Text>
                      <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 11, color: colors.textMuted, marginTop: 2 }}>
                        When off, the only signup option is the link above.
                      </Text>
                    </View>
                    <Switch
                      value={allowJanataSignup}
                      onValueChange={setAllowJanataSignup}
                      trackColor={{ true: '#E8862A', false: colors.border }}
                      thumbColor="#FFFFFF"
                      ios_backgroundColor={colors.border}
                    />
                  </View>
                ) : null}
              </View>

              {/* Coordinates */}
              <View>
                <FieldLabel label="Coordinates" colors={colors} hint="Override only if the center's pin is wrong." />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <FormInput value={latitude} onChangeText={setLatitude} placeholder="Latitude" colors={colors} hasError={!!errors.latitude} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <FormInput value={longitude} onChangeText={setLongitude} placeholder="Longitude" colors={colors} hasError={!!errors.longitude} />
                  </View>
                </View>
                {errorText('latitude')}
                {errorText('longitude')}
              </View>
            </View>
          ) : null}
        </View>

        {/* Category */}
        <View>
          <FieldLabel label="Category" colors={colors} />
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            {CATEGORY_OPTIONS.map((opt) => {
              const selected = category === opt.value
              return (
                <Pressable
                  key={opt.label}
                  onPress={() => setCategory(opt.value)}
                  style={{
                    paddingHorizontal: 16,
                    paddingVertical: 8,
                    borderRadius: 100,
                    backgroundColor: selected ? '#E8862A' : colors.iconBoxBg,
                  }}
                >
                  <Text
                    style={{
                      fontFamily: selected ? 'Inclusive Sans' : 'Inclusive Sans',
                      fontSize: 12,
                      color: selected ? '#FFFFFF' : colors.textSecondary,
                    }}
                  >
                    {opt.label}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        </View>
      </ScrollView>

      {/* Sticky action bar */}
      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: colors.border,
          padding: 16,
          backgroundColor: colors.panelBg,
          flexDirection: 'row',
          justifyContent: 'flex-end',
          gap: 10,
        }}
      >
        <SecondaryButton
          onPress={onClose}
          style={{ paddingHorizontal: 20, paddingVertical: 10 }}
        >
          Cancel
        </SecondaryButton>
        <PrimaryButton
          onPress={handleSave}
          disabled={saving}
          loading={saving}
          style={{ paddingHorizontal: 24, paddingVertical: 10 }}
        >
          {isEdit ? 'Save Changes' : 'Create Event'}
        </PrimaryButton>
      </View>
    </View>
  )
}

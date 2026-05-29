import React, { useState, useEffect, useRef } from 'react'
import {
  ScrollView,
  View,
  TextInput,
  Pressable,
  Image,
  ActivityIndicator,
  Platform,
  useWindowDimensions,
} from 'react-native'
import { Camera, Pencil, MapPin } from 'lucide-react-native'
import { useUser, useTheme } from '../../components/contexts'
import { Text } from '../../components/ui'
import BirthdatePicker from '../../components/profile/BirthdatePicker'
import WebAvatarCropper from '../../components/profile/AvatarCropper.web'
import { fetchCenters, CenterData } from '../../utils/api'
import { useAnalytics } from '../../utils/analytics'

type ProfileData = {
  name: string
  bio: string
  birthday: Date | null
  interests: string[]
  profileImage: string | null
  centerID: string | null
}

function formatBirthday(date: Date | null): string {
  if (!date) return ''
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

/** ISO date string (YYYY-MM-DD) from a Date, or empty string */
function toISODate(date: Date | null): string {
  if (!date) return ''
  return date.toISOString().split('T')[0]
}

/** Parse YYYY-MM-DD to Date, or null */
function parseISODate(str: string): Date | null {
  if (!str) return null
  const d = new Date(str + 'T00:00:00')
  return isNaN(d.getTime()) ? null : d
}

const PREFERENCE_OPTIONS = [
  'Satsangs',
  'Bhiksha',
  'Global events',
  'Local events',
  'Casual',
  'Formal',
]

export default function Profile() {
  const { user, updateProfile, setUser } = useUser()
  const { isDark } = useTheme()
  const { track } = useAnalytics()
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [errors, setErrors] = useState<{ [key: string]: string }>({})
  const isWeb = Platform.OS === 'web'

  const getDisplayName = () => {
    if (user?.firstName && user?.lastName) return `${user.firstName} ${user.lastName}`
    if (user?.firstName) return user.firstName
    return user?.username || ''
  }

  const getInitials = () => {
    if (user?.firstName && user?.lastName) {
      return `${user.firstName[0]}${user.lastName[0]}`.toUpperCase()
    }
    if (user?.firstName) return user.firstName[0].toUpperCase()
    if (user?.username) return user.username[0].toUpperCase()
    return '?'
  }

  const hasExistingProfileImage = !!user?.profileImage

  // Store the original uploaded image (before cropping) for re-editing
  const [originalImage, setOriginalImage] = useState<string | null>(user?.originalImage || null)

  const [profileData, setProfileData] = useState<ProfileData>({
    name: getDisplayName(),
    bio: user?.bio || '',
    birthday: user?.dateOfBirth ? new Date(user.dateOfBirth) : null,
    interests: user?.interests || [],
    profileImage: user?.profileImage || null,
    centerID: user?.centerID || null,
  })

  const [allCenters, setAllCenters] = useState<CenterData[]>([])
  const [centerSearch, setCenterSearch] = useState('')
  const [centerResults, setCenterResults] = useState<CenterData[]>([])
  const [showCenterPicker, setShowCenterPicker] = useState(false)
  const [showBirthdayPicker, setShowBirthdayPicker] = useState(false)
  const [centerSearchLoading, setCenterSearchLoading] = useState(false)
  const centerSearchTimer = useRef<NodeJS.Timeout | null>(null)

  const draftName = useRef(profileData.name)
  const draftBio = useRef(profileData.bio)
  const draftBirthday = useRef<Date | null>(profileData.birthday)
  const savedInterests = useRef<string[]>(profileData.interests)
  const savedProfileImage = useRef<string | null>(profileData.profileImage)
  const savedCenterID = useRef<string | null>(profileData.centerID)

  const [cropperImage, setCropperImage] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleAvatarPress = () => {
    track('profile_avatar_edit_opened', { source: 'profile', has_existing_image: !!profileData.profileImage })
    // If user has an existing profile image, use the original (uncropped) if available in session
    if (originalImage || user?.originalImage) {
      setCropperImage(originalImage || user?.originalImage || null)
    } else if (profileData.profileImage) {
      setCropperImage(profileData.profileImage)
    } else {
      // New user - open file picker directly
      fileInputRef.current?.click()
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      const url = URL.createObjectURL(file)
      setOriginalImage(url)
      setCropperImage(url)
      track('profile_avatar_file_selected', { source: 'profile', file_type: file.type })
    }
  }

  const [profileImageChanged, setProfileImageChanged] = useState(false)

  const handleCropComplete = (blob: Blob) => {
    const url = URL.createObjectURL(blob)
    setProfileData((prev) => ({ ...prev, profileImage: url }))
    setProfileImageChanged(true)
    setCropperImage(null)
    track('profile_avatar_cropped', { source: 'profile' })
  }

  const handleCropCancel = () => {
    setCropperImage(null)
    track('profile_avatar_crop_cancelled', { source: 'profile' })
  }

  const handleReplacePhoto = () => {
    fileInputRef.current?.click()
  }

  useEffect(() => {
    if (user && !isEditing) {
      setProfileData((prev) => ({
        ...prev,
        name: getDisplayName() || prev.name,
        bio: user.bio || prev.bio,
        profileImage: user.profileImage || prev.profileImage,
        interests: user.interests || prev.interests,
        centerID: user.centerID || prev.centerID,
      }))
    }
  }, [
    user?.firstName,
    user?.lastName,
    user?.profileImage,
    user?.bio,
    user?.interests,
    user?.centerID,
  ])

  useEffect(() => {
    const loadCenters = async () => {
      try {
        const centers = await fetchCenters()
        setAllCenters(centers)
      } catch (e) {
        // Silently fail
      }
    }
    loadCenters()
  }, [])

  useEffect(() => {
    if (centerSearchTimer.current) {
      clearTimeout(centerSearchTimer.current)
    }

    if (centerSearch.length >= 3) {
      setCenterSearchLoading(true)
      centerSearchTimer.current = setTimeout(async () => {
        try {
          const response = await fetch(
            `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
              centerSearch
            )}&format=json&limit=1&countrycodes=us`
          )
          if (response.ok) {
            const data = await response.json()
            if (data.length > 0) {
              const userLat = parseFloat(data[0].lat)
              const userLon = parseFloat(data[0].lon)

              const centersWithDistance = allCenters
                .filter((c) => c.latitude != null && c.longitude != null)
                .map((center) => ({
                  ...center,
                  distance: Math.sqrt(
                    Math.pow((center.latitude - userLat) * 69, 2) +
                      Math.pow((center.longitude - userLon) * 54.6, 2)
                  ),
                }))
                .sort((a, b) => a.distance - b.distance)
                .slice(0, 5)

              setCenterResults(centersWithDistance)
              setShowCenterPicker(true)
            }
          }
        } catch (e) {
          // Silently fail
        } finally {
          setCenterSearchLoading(false)
        }
      }, 500)
    } else {
      setCenterResults([])
      setShowCenterPicker(false)
    }

    return () => {
      if (centerSearchTimer.current) {
        clearTimeout(centerSearchTimer.current)
      }
    }
  }, [centerSearch, allCenters])

  useEffect(() => {
    draftName.current = profileData.name
    draftBio.current = profileData.bio
  }, [profileData.name, profileData.bio])

  const readDrafts = () => ({
    name: draftName.current,
    bio: draftBio.current,
    birthday: draftBirthday.current,
    interests: profileData.interests,
    centerID: profileData.centerID,
  })

  const validateForm = (): boolean => {
    const drafts = readDrafts()
    const newErrors: { [key: string]: string } = {}
    if (!drafts.name.trim()) newErrors.name = 'Name is required'
    if (!drafts.birthday) newErrors.birthday = 'Birthday is required'
    if (profileData.interests.length === 0)
      newErrors.interests = 'At least one interest must be selected'
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const nameRef = useRef<any>(null)
  const bioRef = useRef<any>(null)

  const handleEdit = () => {
    draftName.current = profileData.name
    draftBio.current = profileData.bio
    draftBirthday.current = profileData.birthday
    savedInterests.current = [...profileData.interests]
    savedProfileImage.current = profileData.profileImage
    savedCenterID.current = profileData.centerID
    setIsEditing(true)
    track('profile_edit_started', { source: 'profile', username: user?.username })
  }

  const handleCancel = () => {
    // Reset input values back to original via refs
    if (isWeb) {
      if (nameRef.current) nameRef.current.value = profileData.name
      if (bioRef.current) bioRef.current.value = profileData.bio
    }
    draftBirthday.current = profileData.birthday
    setProfileData((prev) => ({
      ...prev,
      interests: savedInterests.current,
      profileImage: savedProfileImage.current,
      centerID: savedCenterID.current,
    }))
    setProfileImageChanged(false)
    setErrors({})
    setIsEditing(false)
    track('profile_edit_cancelled', { source: 'profile', username: user?.username })
  }

  const handleSave = async () => {
    if (!validateForm()) return
    const drafts = readDrafts()
    setProfileData((prev) => ({
      ...prev,
      name: drafts.name,
      bio: drafts.bio,
      birthday: drafts.birthday,
    }))
    setIsSaving(true)
    try {
      const nameParts = drafts.name.trim().split(' ')

      // Prepare profile image if changed
      let profileImageBase64: string | undefined
      if (profileImageChanged && profileData.profileImage) {
        try {
          const response = await fetch(profileData.profileImage)
          if (!response.ok) {
            throw new Error(`Fetch failed: ${response.status}`)
          }
          const blob = await response.blob()
          profileImageBase64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onloadend = () => resolve(reader.result as string)
            reader.onerror = () => reject(new Error('Failed to read blob'))
            reader.readAsDataURL(blob)
          })
        } catch (e) {
          console.error('Error converting image:', e)
          setErrors((prev) => ({
            ...prev,
            profileImage: 'Failed to upload image. Please try again.',
          }))
          track('profile_update_failed', { source: 'profile', username: user?.username, reason: 'image_upload_error' })
          setIsSaving(false)
          return
        }
      }

      const result = await updateProfile({
        firstName: nameParts[0],
        lastName: nameParts.slice(1).join(' '),
        bio: drafts.bio || '',
        interests: drafts.interests,
        ...(drafts.centerID ? { centerID: drafts.centerID } : {}),
        ...(drafts.birthday ? { dateOfBirth: drafts.birthday.toISOString().split('T')[0] } : {}),
        ...(profileImageBase64 ? { profileImage: profileImageBase64 } : {}),
      })

      if (!result.success) {
        setErrors((prev) => ({ ...prev, form: result.message || 'Failed to save profile' }))
        track('profile_update_failed', { source: 'profile', username: user?.username, reason: result.message || 'api_error' })
        setIsSaving(false)
        return
      }
      setProfileImageChanged(false)
      // Cache the cropped image as the original for re-editing in this session
      if (originalImage && user) {
        setUser({ ...user, originalImage: originalImage })
      }
      track('profile_updated', { source: 'profile', username: user?.username })
      setIsEditing(false)
      setErrors({})
    } catch (error) {
      if (__DEV__) console.error('Error saving profile:', error)
      track('profile_update_failed', { source: 'profile', username: user?.username, reason: 'exception' })
      setIsEditing(false)
      setErrors({})
    } finally {
      setIsSaving(false)
    }
  }

  const handlePreferenceToggle = (preference: string) => {
    if (!isEditing) return
    const willSelect = !profileData.interests.includes(preference)
    setProfileData((prev) => ({
      ...prev,
      interests: prev.interests.includes(preference)
        ? prev.interests.filter((p) => p !== preference)
        : [...prev.interests, preference],
    }))
    track('profile_interest_toggled', { source: 'profile', interest: preference, selected: willSelect })
  }

  const labelColor = isDark ? '#78716C' : '#A8A29E'
  const textColor = isDark ? '#FAFAFA' : '#1C1917'
  const mutedTextColor = isDark ? '#A8A29E' : '#78716C'
  const borderColor = isDark ? '#262626' : '#ECE7DE'
  const cardBg = isDark ? '#262626' : '#FFFFFF'
  const chipBg = isDark ? '#262626' : '#F3F0ED'

  const inputStyle = {
    fontFamily: 'Inclusive Sans' as const,
    fontSize: 15,
    color: textColor,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor,
    backgroundColor: cardBg,
  }

  const multilineInputStyle = {
    ...inputStyle,
    minHeight: 100,
  }

  const labelStyle = {
    fontFamily: 'Inclusive Sans' as const,
    fontSize: 12,
    color: labelColor,
    letterSpacing: 1,
    textTransform: 'uppercase' as const,
    marginBottom: 6,
  }

  const hiddenStyle = { display: 'none' as const }

  // ═══════════════════════════════════════════
  //  MOBILE LAYOUT
  // ═══════════════════════════════════════════
  if (!isWeb) {
    return (
      <ScrollView style={{ flex: 1, backgroundColor: isDark ? '#171717' : '#FAFAF7' }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            paddingTop: 28,
            paddingBottom: 24,
            paddingHorizontal: 20,
            gap: 16,
          }}
        >
          <View style={{ position: 'relative' }}>
            {profileData.profileImage ? (
              <Image
                source={{ uri: profileData.profileImage }}
                style={{
                  width: 88,
                  height: 88,
                  borderRadius: 44,
                  borderWidth: 3,
                  borderColor: cardBg,
                  backgroundColor: '#D6D3D1',
                }}
              />
            ) : (
              <View
                style={{
                  width: 88,
                  height: 88,
                  borderRadius: 44,
                  borderWidth: 3,
                  borderColor: cardBg,
                  backgroundColor: '#C2410C',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontSize: 28, fontWeight: '600' }}>
                  {getInitials()}
                </Text>
              </View>
            )}
            {isEditing && (
              <Pressable
                style={{
                  position: 'absolute',
                  bottom: -6,
                  right: -6,
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  backgroundColor: '#C2410C',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: 2,
                  borderColor: isDark ? '#171717' : '#FAFAF7',
                }}
                onPress={handleAvatarPress}
              >
                <Camera size={16} color="#fff" />
              </Pressable>
            )}
          </View>
          <View style={{ flex: 1, minWidth: 0, justifyContent: 'center', paddingTop: 2 }}>
            {isEditing ? (
              <TextInput
                defaultValue={profileData.name}
                onChangeText={(v) => {
                  draftName.current = v
                }}
                placeholderTextColor="#9ca3af"
                style={{
                  fontFamily: 'Inclusive Sans',
                  fontSize: 22,
                  color: textColor,
                  letterSpacing: -0.5,
                  marginBottom: 6,
                  width: '100%',
                  padding: 0,
                  textAlign: 'left',
                }}
              />
            ) : (
              <Text
                style={{
                  fontFamily: 'Inclusive Sans',
                  fontSize: 22,
                  color: textColor,
                  letterSpacing: -0.5,
                  marginBottom: 6,
                }}
              >
                {profileData.name || '—'}
              </Text>
            )}
            <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 14, color: mutedTextColor }}>
              {user?.email ||
                (user?.username ? `@${user.username}` : '') ||
                '—'}
            </Text>
            {isEditing && user?.email && user.email !== user.username && (
              <Text
                style={{
                  fontFamily: 'Inclusive Sans',
                  fontSize: 13,
                  color: mutedTextColor,
                  marginTop: 4,
                }}
              >
                @{user.username}
              </Text>
            )}
          </View>
        </View>

        <View style={{ paddingHorizontal: 20, gap: 20 }}>
          <View>
            <Text style={labelStyle}>Bio</Text>
            {isEditing ? (
              <TextInput
                defaultValue={profileData.bio}
                onChangeText={(v) => {
                  draftBio.current = v
                }}
                multiline
                textAlignVertical="top"
                placeholderTextColor="#9ca3af"
                style={multilineInputStyle}
              />
            ) : (
              <Text
                style={{
                  fontFamily: 'Inclusive Sans',
                  fontSize: 15,
                  color: mutedTextColor,
                  lineHeight: 22,
                }}
              >
                {profileData.bio || '—'}
              </Text>
            )}
            {errors.bio && (
              <Text
                style={{
                  fontFamily: 'Inclusive Sans',
                  fontSize: 13,
                  color: '#DC2626',
                  marginTop: 6,
                }}
              >
                {errors.bio}
              </Text>
            )}
          </View>
          <View>
            <Text style={labelStyle}>Birthday</Text>
            {isEditing ? (
              <BirthdatePicker
                value={draftBirthday.current ?? undefined}
                onChange={(d: Date) => {
                  draftBirthday.current = d
                }}
              />
            ) : (
              <Text
                style={{
                  fontFamily: 'Inclusive Sans',
                  fontSize: 16,
                  color: textColor,
                  lineHeight: 24,
                }}
              >
                {formatBirthday(profileData.birthday) || '—'}
              </Text>
            )}
            {errors.birthday && (
              <Text
                style={{
                  fontFamily: 'Inclusive Sans',
                  fontSize: 13,
                  color: '#DC2626',
                  marginTop: 6,
                }}
              >
                {errors.birthday}
              </Text>
            )}
          </View>

          <View>
            <Text style={labelStyle}>Center</Text>
            {isEditing ? (
              <View
                style={{
                  position: 'relative',
                  marginBottom: showCenterPicker && centerResults.length > 0 ? 200 : 0,
                }}
              >
                <TextInput
                  value={
                    centerSearch ||
                    allCenters.find((c) => c.centerID === profileData.centerID)?.name ||
                    ''
                  }
                  onChangeText={(text) => {
                    setCenterSearch(text)
                    if (text.length < 3) {
                      setShowCenterPicker(false)
                    }
                    if (text === '') {
                      setProfileData((prev) => ({ ...prev, centerID: null }))
                    }
                  }}
                  onFocus={() => {
                    if (centerResults.length > 0) {
                      setShowCenterPicker(true)
                    }
                  }}
                  placeholder="Search by city or town"
                  placeholderTextColor="#9ca3af"
                  style={inputStyle}
                />
                {centerSearchLoading && (
                  <View style={{ position: 'absolute', right: 12, top: 14 }}>
                    <ActivityIndicator size="small" color="#C2410C" />
                  </View>
                )}
                {showCenterPicker && centerResults.length > 0 && (
                  <View
                    style={{
                      position: 'absolute',
                      top: '100%',
                      left: 0,
                      right: 0,
                      backgroundColor: cardBg,
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor,
                      maxHeight: 200,
                      zIndex: 200,
                      marginTop: 8,
                      shadowColor: '#000',
                      shadowOffset: { width: 0, height: 2 },
                      shadowOpacity: 0.1,
                      shadowRadius: 8,
                      elevation: 5,
                    }}
                  >
                    {centerResults.map((center) => (
                      <Pressable
                        key={center.centerID}
                        onPress={() => {
                          setProfileData((prev) => ({ ...prev, centerID: center.centerID }))
                          setCenterSearch('')
                          setShowCenterPicker(false)
                          track('profile_center_selected', { source: 'profile', center_id: center.centerID, center_name: center.name })
                        }}
                        style={{
                          paddingHorizontal: 16,
                          paddingVertical: 12,
                          borderBottomWidth: 1,
                          borderBottomColor: borderColor,
                          backgroundColor:
                            profileData.centerID === center.centerID
                              ? '#C2410C' + '20'
                              : 'transparent',
                        }}
                      >
                        <Text
                          style={{
                            fontFamily: 'Inclusive Sans',
                            fontSize: 14,
                            color:
                              profileData.centerID === center.centerID ? '#C2410C' : textColor,
                          }}
                        >
                          {center.name}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                <MapPin size={18} color={mutedTextColor} style={{ marginTop: 2 }} />
                <Text
                  style={{
                    fontFamily: 'Inclusive Sans',
                    fontSize: 15,
                    color: mutedTextColor,
                    flex: 1,
                    lineHeight: 22,
                  }}
                >
                  {profileData.centerID
                    ? allCenters.find((c) => c.centerID === profileData.centerID)?.name || '—'
                    : '—'}
                </Text>
              </View>
            )}
          </View>

          <View>
            <Text
              style={{
                fontFamily: 'Inclusive Sans',
                fontSize: 12,
                color: labelColor,
                letterSpacing: 1,
                textTransform: 'uppercase',
                marginBottom: 12,
              }}
            >
              Interests
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {PREFERENCE_OPTIONS.map((pref) => {
                const selected = profileData.interests.includes(pref)
                return (
                  <Pressable
                    key={pref}
                    onPress={() => handlePreferenceToggle(pref)}
                    disabled={!isEditing}
                    style={{
                      paddingHorizontal: 18,
                      paddingVertical: 12,
                      borderRadius: 100,
                      minHeight: 44,
                      justifyContent: 'center',
                      backgroundColor: selected ? '#C2410C' : chipBg,
                      opacity: !isEditing && !selected ? 0.5 : 1,
                    }}
                  >
                    <Text
                      style={{
                        fontFamily: 'Inclusive Sans',
                        fontSize: 14,
                        color: selected ? '#FFFFFF' : mutedTextColor,
                      }}
                    >
                      {pref}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
            {errors.interests && (
              <Text
                style={{
                  fontFamily: 'Inclusive Sans',
                  fontSize: 13,
                  color: '#DC2626',
                  marginTop: 8,
                }}
              >
                {errors.interests}
              </Text>
            )}
          </View>

          {/* Form-level errors */}
          {(errors.form || errors.profileImage) && (
            <Text
              style={{
                fontFamily: 'Inclusive Sans',
                fontSize: 13,
                color: '#DC2626',
                marginTop: 8,
              }}
            >
              {errors.form || errors.profileImage}
            </Text>
          )}

          {!isEditing && (
            <Pressable
              onPress={handleEdit}
              style={{
                marginTop: 16,
                paddingVertical: 14,
                borderRadius: 12,
                minHeight: 48,
                backgroundColor: isDark ? '#F5F5F5' : '#1C1917',
                alignItems: 'center',
                justifyContent: 'center',
                flexDirection: 'row',
                gap: 8,
              }}
            >
              <Pencil size={16} color={isDark ? '#1C1917' : '#FFFFFF'} />
              <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 15, color: isDark ? '#1C1917' : '#FFFFFF' }}>
                Edit Profile
              </Text>
            </Pressable>
          )}

          {isEditing && (
            <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
              <Pressable
                onPress={handleCancel}
                style={{
                  flex: 1,
                  paddingVertical: 14,
                  borderRadius: 12,
                  minHeight: 48,
                  backgroundColor: isDark ? '#262626' : '#F3F0ED',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 15, color: textColor }}>
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                onPress={handleSave}
                disabled={isSaving}
                style={{
                  flex: 1,
                  paddingVertical: 14,
                  borderRadius: 12,
                  minHeight: 48,
                  backgroundColor: '#C2410C',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {isSaving ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 15, color: '#FFFFFF' }}>
                    Save Changes
                  </Text>
                )}
              </Pressable>
            </View>
          )}
        </View>
      </ScrollView>
    )
  }

  // WEB LAYOUT
  const { width: viewportWidth } = useWindowDimensions()
  const isNarrowWeb = viewportWidth < 768
  // Wide desktop gets a two-column field grid; mobile web keeps the stacked
  // single column. Native iOS uses the entirely separate layout above.
  const isWideWeb = viewportWidth >= 1024
  const webPaddingH = isNarrowWeb ? 16 : viewportWidth < 1024 ? 32 : 60
  const faintColor = isDark ? '#525252' : '#C4BEB4'

  // Quiet placeholder for an empty read-only field — reads as "not set yet"
  // rather than a bare em-dash. Hidden entirely when editing.
  const EmptyValue = ({ label }: { label: string }) => (
    <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 15, color: faintColor, fontStyle: 'italic' }}>
      {label}
    </Text>
  )

  return (
    <ScrollView style={{ flex: 1, backgroundColor: isDark ? '#171717' : '#FAFAF7' }}>
      <View
        style={{
          maxWidth: isWideWeb ? 1080 : 900,
          width: '100%',
          alignSelf: 'center',
          padding: isNarrowWeb ? 20 : 40,
          paddingHorizontal: webPaddingH,
          gap: isNarrowWeb ? 24 : 36,
        }}
      >
        {/* Header row */}
        <View
          style={{
            flexDirection: isNarrowWeb ? 'column' : 'row',
            justifyContent: 'space-between',
            alignItems: isNarrowWeb ? 'stretch' : 'flex-start',
            gap: isNarrowWeb ? 16 : 0,
          }}
        >
          <View style={{ gap: 4 }}>
            <Text
              style={{
                fontSize: isNarrowWeb ? 28 : 34,
                fontWeight: '600',
                color: textColor,
                letterSpacing: -0.5,
              }}
            >
              Profile
            </Text>
            <Text style={{ fontSize: 15, color: mutedTextColor, marginTop: 4 }}>
              Manage your public profile information
            </Text>
          </View>
          <Pressable
            onPress={isEditing ? handleSave : handleEdit}
            disabled={isSaving}
            style={{
              paddingHorizontal: 24,
              paddingVertical: 12,
              borderRadius: 10,
              minHeight: 44,
              backgroundColor: isEditing ? '#C2410C' : isDark ? '#F5F5F5' : '#1C1917',
              alignItems: 'center',
              justifyContent: 'center',
              alignSelf: isNarrowWeb ? 'stretch' : 'auto',
              flexDirection: 'row',
              gap: 8,
            }}
          >
            {isSaving ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Pencil size={16} color={isEditing ? '#FFFFFF' : isDark ? '#1C1917' : '#FFFFFF'} />
                <Text
                  style={{
                    fontFamily: 'Inclusive Sans',
                    fontSize: 14,
                    color: isEditing ? '#FFFFFF' : isDark ? '#1C1917' : '#FFFFFF',
                  }}
                >
                  {isEditing ? 'Save Changes' : 'Edit Profile'}
                </Text>
              </>
            )}
          </Pressable>
        </View>

        {/* Profile card — avatar + name row on all breakpoints */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: isNarrowWeb ? 16 : 28,
            padding: isNarrowWeb ? 20 : 28,
            backgroundColor: cardBg,
            borderRadius: 20,
            borderWidth: 1,
            borderColor,
          }}
        >
          <View style={{ position: 'relative' }}>
            {profileData.profileImage ? (
              <Image
                source={{ uri: profileData.profileImage }}
                style={{ width: 96, height: 96, borderRadius: 48, backgroundColor: '#D6D3D1' }}
              />
            ) : (
              <View
                style={{
                  width: 96,
                  height: 96,
                  borderRadius: 48,
                  backgroundColor: '#C2410C',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontSize: 32, fontWeight: '600' }}>
                  {getInitials()}
                </Text>
              </View>
            )}
            {isEditing && (
              <Pressable
                style={{
                  position: 'absolute',
                  bottom: -4,
                  right: -4,
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  backgroundColor: '#C2410C',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: 2,
                  borderColor: cardBg,
                }}
                onPress={handleAvatarPress}
              >
                <Camera size={16} color="#fff" />
              </Pressable>
            )}
          </View>
          <View style={{ gap: 6, alignItems: 'flex-start', flex: 1, minWidth: 0 }}>
            {isEditing ? (
              <View
                style={{
                  borderBottomWidth: 2,
                  borderBottomColor: '#C2410C',
                  paddingBottom: 2,
                  width: '100%',
                }}
              >
                <TextInput
                  defaultValue={profileData.name}
                  onChangeText={(v) => {
                    draftName.current = v
                  }}
                  placeholderTextColor="#9ca3af"
                  style={{
                    fontFamily: 'Inclusive Sans',
                    fontSize: isNarrowWeb ? 22 : 24,
                    color: textColor,
                    letterSpacing: -0.3,
                    width: '100%',
                    padding: 0,
                    margin: 0,
                  }}
                />
              </View>
            ) : (
              <Text
                style={{
                  fontFamily: 'Inclusive Sans',
                  fontSize: isNarrowWeb ? 22 : 24,
                  color: textColor,
                  letterSpacing: -0.3,
                }}
              >
                {profileData.name || '—'}
              </Text>
            )}
            <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 14, color: mutedTextColor }}>
              {user?.email ||
                (user?.username ? `@${user.username}` : '') ||
                '—'}
            </Text>
            {isEditing && user?.email && user.email !== user.username && (
              <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 13, color: mutedTextColor }}>
                @{user.username}
              </Text>
            )}
          </View>
        </View>

        {/* Birthday + Center — side by side on wide desktop, stacked otherwise.
            Both are compact fields, so pairing them tightens the page and
            uses the extra width instead of leaving a tall sparse column. */}
        <View style={{ flexDirection: isWideWeb ? 'row' : 'column', gap: isWideWeb ? 28 : (isNarrowWeb ? 20 : 28), zIndex: 1 }}>
          <View style={{ flex: 1, gap: 8 }}>
            <Text style={labelStyle}>Birthday</Text>
            {isEditing ? (
              <View>
                <BirthdatePicker
                  value={draftBirthday.current ?? undefined}
                  onChange={(d: Date) => {
                    draftBirthday.current = d
                  }}
                />
              </View>
            ) : (
              <View
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  backgroundColor: cardBg,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor,
                }}
              >
                {profileData.birthday ? (
                  <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 15, color: textColor }}>
                    {formatBirthday(profileData.birthday)}
                  </Text>
                ) : (
                  <EmptyValue label="Not added yet" />
                )}
              </View>
            )}
            {errors.birthday && (
              <Text
                style={{
                  fontFamily: 'Inclusive Sans',
                  fontSize: 13,
                  color: '#DC2626',
                  marginTop: 6,
                }}
              >
                {errors.birthday}
              </Text>
            )}
          </View>

          {/* Center */}
          <View style={{ flex: 1, gap: 8 }}>
            <Text style={labelStyle}>Center</Text>
            {isEditing ? (
            <View
              style={{
                position: 'relative',
                marginBottom: showCenterPicker && centerResults.length > 0 ? 200 : 0,
              }}
            >
              <TextInput
                value={
                  centerSearch ||
                  allCenters.find((c) => c.centerID === profileData.centerID)?.name ||
                  ''
                }
                onChangeText={(text) => {
                  setCenterSearch(text)
                  if (text.length < 3) {
                    setShowCenterPicker(false)
                  }
                  if (text === '') {
                    setProfileData((prev) => ({ ...prev, centerID: null }))
                  }
                }}
                onFocus={() => {
                  if (centerResults.length > 0) {
                    setShowCenterPicker(true)
                  }
                }}
                placeholder="Search by city or town"
                placeholderTextColor="#9ca3af"
                style={inputStyle}
              />
              {centerSearchLoading && (
                <View style={{ position: 'absolute', right: 12, top: 14 }}>
                  <ActivityIndicator size="small" color="#C2410C" />
                </View>
              )}
              {showCenterPicker && centerResults.length > 0 && (
                <View
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    right: 0,
                    backgroundColor: cardBg,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor,
                    maxHeight: 200,
                    zIndex: 200,
                    marginTop: 8,
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 2 },
                    shadowOpacity: 0.1,
                    shadowRadius: 8,
                    elevation: 5,
                  }}
                >
                  <ScrollView style={{ maxHeight: 200 }}>
                    {centerResults.map((center) => (
                      <Pressable
                        key={center.centerID}
                        onPressIn={() => {
                          setProfileData((prev) => ({ ...prev, centerID: center.centerID }))
                          setCenterSearch('')
                          setShowCenterPicker(false)
                          track('profile_center_selected', { source: 'profile', center_id: center.centerID, center_name: center.name })
                        }}
                        style={{
                          paddingHorizontal: 16,
                          paddingVertical: 12,
                          borderBottomWidth: 1,
                          borderBottomColor: borderColor,
                          backgroundColor:
                            profileData.centerID === center.centerID
                              ? '#C2410C' + '20'
                              : 'transparent',
                        }}
                      >
                        <Text
                          style={{
                            fontFamily: 'Inclusive Sans',
                            fontSize: 14,
                            color:
                              profileData.centerID === center.centerID ? '#C2410C' : textColor,
                          }}
                        >
                          {center.name}
                        </Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                </View>
              )}
            </View>
          ) : (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: 10,
                paddingHorizontal: 16,
                paddingVertical: 14,
                backgroundColor: cardBg,
                borderRadius: 12,
                borderWidth: 1,
                borderColor,
              }}
            >
              <MapPin size={18} color={mutedTextColor} style={{ marginTop: 2 }} />
              <Text
                style={{
                  fontFamily: 'Inclusive Sans',
                  fontSize: 15,
                  color: mutedTextColor,
                  flex: 1,
                  lineHeight: 22,
                }}
              >
                {profileData.centerID
                  ? allCenters.find((c) => c.centerID === profileData.centerID)?.name || '—'
                  : '—'}
              </Text>
            </View>
          )}
        </View>

        {/* Interests */}
        <View>
          <Text
            style={{
              fontFamily: 'Inclusive Sans',
              fontSize: 12,
              color: labelColor,
              letterSpacing: 1,
              textTransform: 'uppercase',
              marginBottom: 12,
            }}
          >
            Interests
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {PREFERENCE_OPTIONS.map((pref) => {
              const selected = profileData.interests.includes(pref)
              return (
                <Pressable
                  key={pref}
                  onPress={() => handlePreferenceToggle(pref)}
                  disabled={!isEditing}
                  style={{
                    paddingHorizontal: 18,
                    paddingVertical: 12,
                    borderRadius: 100,
                    minHeight: 44,
                    justifyContent: 'center',
                    backgroundColor: selected ? '#C2410C' : chipBg,
                    opacity: !isEditing && !selected ? 0.5 : 1,
                  }}
                >
                  <Text
                    style={{
                      fontFamily: 'Inclusive Sans',
                      fontSize: 14,
                      color: selected ? '#FFFFFF' : mutedTextColor,
                    }}
                  >
                    {pref}
                  </Text>
                </Pressable>
              )
            })}
          </View>
          {errors.interests && (
            <Text
              style={{ fontFamily: 'Inclusive Sans', fontSize: 13, color: '#DC2626', marginTop: 8 }}
            >
              {errors.interests}
            </Text>
          )}
        </View>

        {/* Form-level errors */}
        {(errors.form || errors.profileImage) && (
          <Text
            style={{ fontFamily: 'Inclusive Sans', fontSize: 13, color: '#DC2626', marginTop: 8 }}
          >
            {errors.form || errors.profileImage}
          </Text>
        )}

        {/* Cancel button when editing */}
        {isEditing && (
          <Pressable
            onPress={handleCancel}
            style={{
              alignSelf: isNarrowWeb ? 'stretch' : 'flex-start',
              paddingHorizontal: 24,
              paddingVertical: 12,
              borderRadius: 10,
              minHeight: 44,
              backgroundColor: isDark ? '#262626' : '#F3F0ED',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontFamily: 'Inclusive Sans', fontSize: 14, color: textColor }}>
              Cancel
            </Text>
          </Pressable>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />

        {cropperImage && (
          <WebAvatarCropper
            visible={!!cropperImage}
            imageUri={cropperImage}
            originalImageUri={originalImage || undefined}
            onCropComplete={handleCropComplete}
            onCancel={handleCropCancel}
            onReplacePhoto={handleReplacePhoto}
          />
        )}
      </View>
    </ScrollView>
  )
}

import React from 'react'
import { View } from 'react-native'
import type { AppColors } from '../../tokens'
import type { GroupBoard } from './types'
import { DesktopColumns } from '../layout/DesktopColumns'
import { GhostFeed } from './GhostFeed'
import { FeedSetupRail } from './FeedSetupRail'
import { FeedContextRail } from './FeedContextRail'

// The state-aware empty feed. One component owns all three no-posts states
// across desktop (two-column) and mobile (stacked), so the "log in → join a
// center" story stays identical everywhere:
//   guest      — not signed in: explain the feed + sign-in / center-pick steps
//   joinCenter — signed in, no boards: step 1 done, pick a center inline
//   firstPost  — signed in, has boards, no posts: nudge to write the first post
export function FeedEmptyState({
  colors,
  isDesktop,
  isSignedIn,
  groups,
  query,
  centerName,
  onChangeQuery,
  onSignIn,
  onJoinCenter,
  onBrowseEvents,
  onPasteInvite,
  onCompose,
  onOpenGroup,
}: {
  colors: AppColors
  isDesktop: boolean
  isSignedIn: boolean
  groups: GroupBoard[]
  query: string
  centerName?: string
  onChangeQuery?: (value: string) => void
  onSignIn: () => void
  onJoinCenter: (centerId: string) => Promise<boolean> | void
  onBrowseEvents: () => void
  /** Hard-gate path for the not-yet-invited: paste an invite link or code. */
  onPasteInvite?: () => void
  onCompose?: () => void
  onOpenGroup: (group: GroupBoard) => void
}) {
  const boardGroups = groups.filter((group) => group.kind !== 'public')
  const state: 'guest' | 'joinCenter' | 'firstPost' = !isSignedIn
    ? 'guest'
    : boardGroups.length > 0
      ? 'firstPost'
      : 'joinCenter'

  const ghost = (
    <GhostFeed
      colors={colors}
      variant={state === 'firstPost' ? 'firstPost' : 'welcome'}
      centerName={centerName}
      onCompose={onCompose}
      showWelcomeCard={!(isDesktop && state === 'guest')}
    />
  )

  const setupRail = (
    <FeedSetupRail
      colors={colors}
      isSignedIn={isSignedIn}
      onSignIn={onSignIn}
      onJoinCenter={onJoinCenter}
      onBrowseEvents={onBrowseEvents}
      onPasteInvite={onPasteInvite}
    />
  )

  if (isDesktop) {
    const rail =
      state === 'firstPost' ? (
        <FeedContextRail
          groups={groups}
          colors={colors}
          query={query}
          onChangeQuery={onChangeQuery}
          onOpenGroup={onOpenGroup}
        />
      ) : (
        setupRail
      )
    return <DesktopColumns main={ghost} rail={rail} />
  }

  // Mobile: stack the priority CTA on top, ghost preview below. For firstPost the
  // nudge already leads the ghost column, so the boards list trails it.
  if (state === 'firstPost') {
    return (
      <View style={{ gap: 16 }}>
        {ghost}
        <FeedContextRail
          groups={groups}
          colors={colors}
          query={query}
          onOpenGroup={onOpenGroup}
          hideSearch
        />
      </View>
    )
  }

  return state === 'guest' ? setupRail : (
    <View style={{ gap: 16 }}>
      {setupRail}
      {ghost}
    </View>
  )
}

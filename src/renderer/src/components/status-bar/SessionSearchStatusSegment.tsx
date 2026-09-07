import { AlertCircle, Loader2, Pause } from 'lucide-react'
import { useAppStore } from '@/store'
import { useSearchIndexing } from '../right-sidebar/ai-vault-search-coverage-poll'
import {
  SessionSearchIndexingPanel,
  indexingPhaseLabel
} from '../settings/SessionSearchIndexingPanel'
import { resolveAiVaultSearchSettings } from '../../../../shared/ai-vault-search-settings'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'

export function SessionSearchStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const policy = resolveAiVaultSearchSettings(settings)
  const indexing = useSearchIndexing(policy.enabled)
  const progress = indexing.coverage?.indexing
  if (
    !progress ||
    progress.phase === 'complete' ||
    (progress.phase === 'updating' && indexing.observedAt - progress.startedAt < 4000)
  ) {
    return null
  }
  const label = indexingPhaseLabel(progress.phase)
  const Icon =
    progress.phase === 'paused' ? Pause : progress.phase === 'error' ? AlertCircle : Loader2
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="flex items-center gap-1.5 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon
            className={
              progress.phase === 'paused' || progress.phase === 'error'
                ? 'size-3'
                : 'size-3 animate-spin'
            }
          />
          {!iconOnly ? <span>{label}</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="w-80 space-y-4 p-4"
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
      >
        <SessionSearchIndexingPanel
          {...indexing}
          onControl={(paused) => {
            void indexing.control(() =>
              useAppStore.getState().updateSettingsOrThrow({ aiVaultSearch: { ...policy, paused } })
            )
          }}
        />
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            const state = useAppStore.getState()
            state.openSettingsPage()
            state.setSettingsSearchQuery('Agent Session History')
          }}
        >
          {translate('sessionSearch.indexing.openSettings', 'Open settings')}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

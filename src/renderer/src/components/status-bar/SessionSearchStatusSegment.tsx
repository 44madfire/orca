import { AlertCircle, Loader2, Pause } from 'lucide-react'
import { useAppStore } from '@/store'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  useSearchIndexing,
  AI_VAULT_SEARCH_COVERAGE_POLL_MS
} from '../right-sidebar/ai-vault-search-coverage-poll'
import {
  aiVaultIndexingPercentage,
  indexingPhaseLabel
} from '../settings/SessionSearchIndexingPanel'
import { resolveAiVaultSearchSettings } from '../../../../shared/ai-vault-search-settings'
import { translate } from '@/i18n/i18n'

/**
 * Read-only: the settings pane owns pausing, resuming and retrying. This segment says only that
 * search results are still partial, and takes the user to the controls.
 */
export function SessionSearchStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const policy = resolveAiVaultSearchSettings(settings)
  const indexing = useSearchIndexing(policy.enabled)
  const progress = indexing.coverage?.indexing
  // Why: an incremental pass that finishes inside one poll interval would only flicker. Both
  // timestamps are renderer clocks, so this stays meaningful when the index runs on another host.
  const settling =
    progress?.phase === 'updating' &&
    indexing.observedAt - indexing.phaseSince < AI_VAULT_SEARCH_COVERAGE_POLL_MS
  if (!progress || progress.phase === 'complete' || settling) {
    return null
  }
  const percentage = aiVaultIndexingPercentage(progress)
  const phase = indexingPhaseLabel(progress.phase)
  const label =
    percentage === null
      ? phase
      : translate('sessionSearch.indexing.segmentProgress', '{{phase}} · {{percent}}%', {
          phase,
          percent: percentage
        })
  const Icon =
    progress.phase === 'paused' ? Pause : progress.phase === 'error' ? AlertCircle : Loader2
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={() => {
            const state = useAppStore.getState()
            state.openSettingsPage()
            state.setSettingsSearchQuery('Agent Session History')
          }}
          className="flex items-center gap-1.5 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon
            className={
              progress.phase === 'paused' || progress.phase === 'error'
                ? 'size-3'
                : 'size-3 animate-spin motion-reduce:animate-none'
            }
          />
          {!iconOnly ? <span>{label}</span> : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {translate(
          'sessionSearch.indexing.segmentTooltip',
          '{{status}}. Click to open search settings.',
          { status: label }
        )}
      </TooltipContent>
    </Tooltip>
  )
}

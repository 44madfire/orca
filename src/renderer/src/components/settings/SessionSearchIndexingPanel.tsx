import type { AiVaultSearchCoverage } from '../../../../shared/ai-vault-search-types'
import { Button } from '../ui/button'
import { Progress } from '../ui/progress'
import { translate } from '@/i18n/i18n'

export function indexingPhaseLabel(phase: string): string {
  switch (phase) {
    case 'idle':
      return translate('sessionSearch.indexing.idle', 'Waiting to index')
    case 'discovering':
      return translate('sessionSearch.indexing.discovering', 'Finding conversations…')
    case 'indexing':
      return translate('sessionSearch.indexing.indexing', 'Indexing conversations')
    case 'updating':
      return translate('sessionSearch.indexing.updating', 'Updating search index')
    case 'paused':
      return translate('sessionSearch.indexing.paused', 'Indexing paused')
    case 'error':
      return translate('sessionSearch.indexing.failed', 'Index needs attention')
    default:
      return translate('sessionSearch.indexing.complete', 'Up to date')
  }
}

export function SessionSearchIndexingPanel({
  coverage,
  busy,
  error,
  unavailable,
  onControl
}: {
  coverage: AiVaultSearchCoverage | null
  busy: boolean
  error: boolean
  unavailable: boolean
  onControl: (paused: boolean) => void
}): React.JSX.Element {
  const progress = coverage?.indexing
  const phase = progress?.phase
  const canPause = phase !== 'paused' && phase !== 'error' && phase !== 'idle'
  const percentage =
    progress?.filesTotal != null && progress.filesTotal > 0
      ? Math.min(100, Math.floor((progress.filesProcessed / progress.filesTotal) * 100))
      : null
  const label = unavailable
    ? translate('sessionSearch.indexing.statusUnavailable', 'Index status unavailable')
    : phase
      ? indexingPhaseLabel(phase)
      : coverage
        ? indexingPhaseLabel(coverage.backfill === 'complete' ? 'complete' : 'indexing')
        : translate('sessionSearch.indexing.loading', 'Reading index status…')
  return (
    <div className="space-y-3" data-testid="session-search-indexing-panel">
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium">{label}</span>
        {progress ? (
          <Button
            variant="outline"
            size="xs"
            disabled={busy || unavailable}
            onClick={() => onControl(canPause)}
          >
            {busy
              ? translate('sessionSearch.indexing.applying', 'Applying…')
              : canPause
                ? translate('sessionSearch.indexing.pause', 'Pause')
                : phase === 'idle'
                  ? translate('sessionSearch.indexing.start', 'Index now')
                  : phase === 'paused'
                    ? translate('sessionSearch.indexing.resume', 'Resume')
                    : translate('sessionSearch.indexing.retry', 'Retry')}
          </Button>
        ) : null}
      </div>
      {progress && phase !== 'complete' && (percentage !== null || phase === 'discovering') ? (
        <>
          <Progress value={percentage} aria-label={label} className="h-1.5 bg-muted" />
          {percentage !== null ? (
            <p className="text-xs text-muted-foreground tabular-nums">
              {translate(
                'sessionSearch.indexing.files',
                'Files processed: {{processed}} / {{total}} · {{percent}}%',
                {
                  processed: progress.filesProcessed.toLocaleString(),
                  total: progress.filesTotal!.toLocaleString(),
                  percent: percentage
                }
              )}
            </p>
          ) : null}
        </>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {phase === 'paused'
          ? translate(
              'sessionSearch.indexing.pausedDescription',
              'Indexed conversations stay searchable. Resume to catch up on new activity.'
            )
          : phase === 'complete'
            ? translate(
                'sessionSearch.indexing.completeDescription',
                'New activity is indexed automatically.'
              )
            : translate(
                'sessionSearch.indexing.partialDescription',
                'You can search indexed conversations while the rest are added.'
              )}
      </p>
      {coverage ? (
        <p className="text-xs text-muted-foreground tabular-nums">
          {translate(
            'sessionSearch.indexing.counts',
            'Searchable conversations: {{sessions}} · Messages: {{messages}}',
            {
              sessions: coverage.sessionsIndexed.toLocaleString(),
              messages: coverage.messagesIndexed.toLocaleString()
            }
          )}
        </p>
      ) : null}
      {progress && progress.failures > 0 ? (
        <p className="text-xs text-destructive">
          {translate(
            'sessionSearch.indexing.failures',
            '{{count}} indexing issues. Retry to check the remaining files.',
            { count: progress.failures }
          )}
        </p>
      ) : null}
      {error || unavailable ? (
        <p role="alert" className="text-xs text-destructive">
          {translate(
            'sessionSearch.indexing.unavailable',
            'Could not update index status. Please try again.'
          )}
        </p>
      ) : null}
    </div>
  )
}

import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export function PierreDiffLoading({
  error,
  onRetry
}: {
  error: string | null
  onRetry: () => void
}) {
  return (
    <div
      className="flex min-h-16 items-center gap-2 px-3 text-xs text-muted-foreground"
      role="status"
    >
      <span>
        {error ?? translate('auto.components.editor.DiffSectionBody.f5cf81cec2', 'Loading diff...')}
      </span>
      {error && (
        <Button variant="ghost" size="xs" onClick={onRetry}>
          {translate('auto.components.editor.DiffSectionBody.cef4cf0ff5', 'Retry')}
        </Button>
      )}
    </div>
  )
}

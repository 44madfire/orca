import { ChevronRight } from 'lucide-react'
import CommentMarkdown, {
  type CommentMarkdownLinkClickHandler
} from '@/components/sidebar/CommentMarkdown'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'

export function NativeChatReasoningRow({
  markdown,
  onLinkClick,
  allowFileUriLinks
}: {
  markdown: string
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
}): React.JSX.Element | null {
  const firstLine = markdown.trim().split('\n', 1)[0]?.trim()
  if (!firstLine) {
    return null
  }
  const summary = firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine
  const label = translate('components.native-chat.reasoning', 'Reasoning')

  return (
    <Collapsible className="min-w-0 border-l-2 border-border/60 pl-3 text-sm text-muted-foreground">
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-1.5 rounded-sm py-1 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
        <span className="sr-only">{label}: </span>
        <span className="truncate">{summary}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1 italic">
        <CommentMarkdown
          content={markdown}
          variant="document"
          className="text-sm"
          onLinkClick={onLinkClick}
          allowFileUriLinks={allowFileUriLinks}
          linkifyFilePaths={onLinkClick !== undefined}
        />
      </CollapsibleContent>
    </Collapsible>
  )
}

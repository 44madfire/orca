import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

export function NativeChatSkillPill({ node, selected }: NodeViewProps): React.JSX.Element {
  const token = String(node.attrs.token)
  return (
    <NodeViewWrapper as="span" className="inline" contentEditable={false}>
      <Badge
        variant="secondary"
        data-native-chat-skill={token}
        className={`gap-1 border-border px-1.5 py-0 text-sm font-medium text-muted-foreground align-baseline ${selected ? 'ring-1 ring-ring' : ''}`}
      >
        <Zap className="size-3.5" aria-hidden="true" />
        {token.slice(1)}
      </Badge>
    </NodeViewWrapper>
  )
}

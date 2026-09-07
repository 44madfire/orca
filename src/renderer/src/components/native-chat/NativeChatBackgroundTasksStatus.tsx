import { useEffect, useId, useRef, useState } from 'react'
import { Bot, ChevronDown, CircleHelp, Eye, SquareTerminal, Workflow } from 'lucide-react'
import type { AgentSessionBackgroundTask } from '../../../../shared/agent-session-wire'
import { AgentStateDot } from '@/components/AgentStateDot'
import { Button } from '@/components/ui/button'
import { useNow } from '@/hooks/use-now'
import { translate } from '@/i18n/i18n'
import {
  backgroundTaskElapsedLabel,
  backgroundTaskGroupLabel,
  backgroundTasksDotState,
  backgroundTasksHeaderContent,
  backgroundTaskStateReason,
  buildBackgroundTaskGroups,
  type BackgroundRosterTask
} from './background-task-roster'

/** Below this strip width (border-box, live root font size) the header drops
 *  its per-kind breakdown for an honest total. A narrow split pane on a wide
 *  monitor must behave like a narrow window, so no viewport media query. */
const NARROW_STRIP_REM = 24

function rootFontSizePx(): number {
  const parsed = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16
}

/** Observe the strip's own border-box width; the viewport is only the
 *  pre-measurement stand-in before the first observer callback. */
function useNarrowStrip(ref: React.RefObject<HTMLDivElement | null>): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_STRIP_REM * 16)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver((observerEntries) => {
      const width =
        observerEntries[0]?.borderBoxSize?.[0]?.inlineSize ?? element.getBoundingClientRect().width
      setNarrow(width < NARROW_STRIP_REM * rootFontSizePx())
    })
    observer.observe(element, { box: 'border-box' })
    return () => observer.disconnect()
  }, [ref])
  return narrow
}

const KIND_ICONS = {
  agent: Bot,
  command: SquareTerminal,
  monitor: Eye,
  workflow: Workflow,
  unknown: CircleHelp
} as const

function BackgroundTaskRow(props: {
  entry: BackgroundRosterTask
  now: number
  supportsTaskStop: boolean
  stopping: boolean
  onStop: (taskId: string) => void
}): React.JSX.Element {
  const { entry, now } = props
  const Icon = KIND_ICONS[entry.task.kind]
  const reason = entry.state === 'waiting' ? backgroundTaskStateReason(entry.state) : null
  const elapsed = entry.settled ? null : backgroundTaskElapsedLabel(entry.task, now)
  return (
    <li className="flex h-6 min-w-0 items-center gap-2 text-foreground/80">
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <AgentStateDot state={entry.state} size="sm" title={null} />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">{entry.name}</span>
        {reason ? <span className="text-muted-foreground"> · {reason}</span> : null}
      </span>
      {elapsed ? (
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {elapsed}
        </span>
      ) : null}
      {!entry.settled && props.supportsTaskStop ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={translate(
            'components.native-chat.backgroundTasks.stopTask',
            'Stop {{value0}}',
            {
              value0: entry.name
            }
          )}
          disabled={props.stopping}
          onClick={() => props.onStop(entry.task.id)}
        >
          {translate('components.native-chat.backgroundTasks.stop', 'Stop')}
        </Button>
      ) : null}
    </li>
  )
}

export function NativeChatBackgroundTasksStatus(props: {
  tasks: readonly AgentSessionBackgroundTask[]
  settledTasks: readonly AgentSessionBackgroundTask[]
  supportsTaskStop: boolean
  stoppingTaskIds: ReadonlySet<string>
  stoppingAll: boolean
  /** True while the session is idle: only then may the strip speak as the
   *  animated monitoring indicator. A running turn owns the voice. */
  indicatorActive: boolean
  onStop: (taskId?: string) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const taskListId = useId()
  const stripRef = useRef<HTMLDivElement>(null)
  const narrow = useNarrowStrip(stripRef)
  const groups = buildBackgroundTaskGroups(props.tasks, props.settledTasks)
  const singleLiveCommand =
    groups.length === 1 && groups[0].kind === 'command' && groups[0].tasks.length === 1
  const hasElapsed = groups.some((group) =>
    group.tasks.some((entry) => !entry.settled && (entry.task.startedAt ?? 0) > 0)
  )
  const now = useNow(1_000, hasElapsed && (expanded || singleLiveCommand))
  const header = backgroundTasksHeaderContent(groups, { narrow, now })
  const headerText = `${header.segments.join(' · ')}${header.detail ? `${header.segments.length > 0 ? ' — ' : ''}${header.detail}` : ''}`
  return (
    <div
      data-native-chat-background-tasks="true"
      className="shrink-0 bg-background px-3 pt-2 sm:px-4"
    >
      <div
        ref={stripRef}
        className="mx-auto w-full max-w-4xl overflow-hidden rounded-lg border border-border bg-muted/50 text-xs text-muted-foreground shadow-xs"
      >
        <div className="flex h-8 items-center px-1.5">
          <button
            type="button"
            className="flex h-6 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            aria-expanded={expanded}
            aria-controls={taskListId}
            aria-label={headerText}
            onClick={() => setExpanded((current) => !current)}
          >
            <span aria-hidden="true">
              {props.indicatorActive ? (
                <AgentStateDot state={backgroundTasksDotState(groups)} size="md" title={null} />
              ) : (
                // The turn owns the voice: same contents, no animated state glyph.
                <span className="flex size-3 shrink-0 items-center justify-center">
                  <span className="size-2 rounded-full bg-muted-foreground/40" />
                </span>
              )}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {header.segments.map((segment, index) => (
                <span key={segment}>
                  {index > 0 ? <span className="text-border"> · </span> : null}
                  <span className="font-medium text-foreground">{segment}</span>
                </span>
              ))}
              {header.detail ? (
                <span>
                  {header.segments.length > 0 ? ' — ' : null}
                  {header.detail}
                </span>
              ) : null}
            </span>
            <ChevronDown
              aria-hidden="true"
              className={`size-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
            />
          </button>
        </div>
        {expanded ? (
          <div
            id={taskListId}
            className="scrollbar-sleek max-h-40 overflow-y-auto border-t border-border px-3 py-2"
          >
            {groups.length > 0 ? (
              groups.map((group, index) => (
                <div
                  key={group.kind}
                  className={index > 0 ? 'mt-1.5 border-t border-border/60 pt-1.5' : ''}
                >
                  <p className="px-0.5 pb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {backgroundTaskGroupLabel(group.kind)}
                  </p>
                  <ul
                    role="list"
                    aria-label={backgroundTaskGroupLabel(group.kind)}
                    className="space-y-0.5"
                  >
                    {group.tasks.map((entry) => (
                      <BackgroundTaskRow
                        key={entry.task.id}
                        entry={entry}
                        now={now}
                        supportsTaskStop={props.supportsTaskStop}
                        stopping={props.stoppingTaskIds.has(entry.task.id)}
                        onStop={props.onStop}
                      />
                    ))}
                  </ul>
                </div>
              ))
            ) : (
              <p>
                {translate(
                  'components.native-chat.backgroundTasks.detailsUnavailable',
                  'Task details are unavailable for this session.'
                )}
              </p>
            )}
            {!props.supportsTaskStop ? (
              <div className={groups.length > 0 ? 'mt-2 border-t border-border pt-2' : 'mt-2'}>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label={translate(
                    'components.native-chat.backgroundTasks.stopAll',
                    'Stop background tasks'
                  )}
                  disabled={props.stoppingAll}
                  onClick={() => props.onStop()}
                >
                  {translate('components.native-chat.backgroundTasks.stop', 'Stop')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

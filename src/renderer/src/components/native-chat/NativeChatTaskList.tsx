import { Circle, CircleCheck, CircleDot, ChevronRight, ListChecks } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  nativeChatTaskLabel,
  type NativeChatTask,
  type NativeChatTaskList as TaskList
} from '../../../../shared/native-chat-task-list'

function statusLabel(task: NativeChatTask): string {
  if (task.status === 'completed') {
    return translate('components.native-chat.taskList.completed', 'Completed')
  }
  if (task.status === 'in_progress') {
    return translate('components.native-chat.taskList.inProgress', 'In progress')
  }
  return translate('components.native-chat.taskList.pending', 'Pending')
}

function TaskRow({ task }: { task: NativeChatTask }): React.JSX.Element {
  const Icon =
    task.status === 'completed' ? CircleCheck : task.status === 'in_progress' ? CircleDot : Circle
  return (
    <li
      className={cn(
        'flex items-start gap-1.5 text-xs text-muted-foreground',
        task.status === 'in_progress' && 'font-medium text-foreground'
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span className="sr-only">{statusLabel(task)}: </span>
      <span
        className={cn(
          'min-w-0 whitespace-pre-wrap break-words',
          task.status === 'completed' && 'line-through'
        )}
      >
        {nativeChatTaskLabel(task)}
      </span>
    </li>
  )
}

function Checklist({ list }: { list: TaskList }): React.JSX.Element {
  return list.tasks.length === 0 ? (
    <p className="text-xs text-muted-foreground">
      {translate('components.native-chat.taskList.empty', 'No tasks')}
    </p>
  ) : (
    <ul
      aria-label={translate('components.native-chat.taskList.title', 'Tasks')}
      className="space-y-1 py-1"
    >
      {list.tasks.map((task, index) => (
        <TaskRow key={`${task.content}:${index}`} task={task} />
      ))}
    </ul>
  )
}

export function NativeChatTaskList({ list }: { list: TaskList }): React.JSX.Element {
  const completed = list.tasks.filter((task) => task.status === 'completed').length
  return (
    <Collapsible className="rounded-md border border-border bg-muted/30">
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-md px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ListChecks aria-hidden className="size-4 shrink-0" />
        <span className="flex-1 font-medium">
          {translate('components.native-chat.taskList.title', 'Tasks')}
        </span>
        <span
          className="tabular-nums"
          aria-label={translate(
            'components.native-chat.taskList.progress',
            '{{completed}} of {{total}} tasks completed',
            { completed, total: list.tasks.length }
          )}
        >
          {completed}/{list.tasks.length}
        </span>
        <ChevronRight aria-hidden className="size-3.5 group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="max-h-40 overflow-y-auto px-3 pb-2 scrollbar-sleek">
          <Checklist list={list} />
          {list.explanation ? (
            <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
              {list.explanation}
            </p>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

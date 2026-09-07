import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Regex,
  Replace,
  ReplaceAll,
  WholeWord,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import type { DiffSearchQuery } from './pierre-diff-search'

export type DiffSearchSide = 'additions' | 'deletions'
export type PierreDiffSearchBarProps = {
  inputRef: React.RefObject<HTMLInputElement | null>
  query: DiffSearchQuery
  side: DiffSearchSide
  replacement: string
  replaceOpen: boolean
  canReplace: boolean
  canNavigate: boolean
  canReplaceAll: boolean
  status: string
  onQuery: (query: DiffSearchQuery) => void
  onSide: (side: DiffSearchSide) => void
  onReplacement: (text: string) => void
  onToggleReplace: () => void
  onReplace: (all: boolean) => void
  onNavigate: (direction: 1 | -1) => void
  onClose: () => void
}

function SearchButton({
  label,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          onMouseDown={(event) => event.preventDefault()}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function PierreDiffSearchBar(props: PierreDiffSearchBarProps) {
  const { query, onQuery } = props
  return (
    <div className="sticky top-0 z-20 h-0" data-diff-search>
      <div
        className="absolute right-2 top-2 flex max-w-full flex-col gap-1 rounded-md border border-border bg-background p-1 text-foreground shadow-floating"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-1">
          {props.canReplace && (
            <SearchButton
              label="Toggle replace"
              aria-expanded={props.replaceOpen}
              onClick={props.onToggleReplace}
            >
              {props.replaceOpen ? <ChevronDown /> : <ChevronRight />}
            </SearchButton>
          )}
          <Input
            ref={props.inputRef}
            aria-label="Find in diff"
            placeholder="Find"
            value={query.text}
            className="h-7 min-w-0 w-40 text-xs"
            onChange={(event) => onQuery({ ...query, text: event.target.value })}
            onKeyDown={(event) => {
              if (isImeCompositionKeyDown(event)) {
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                props.onNavigate(event.shiftKey ? -1 : 1)
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                props.onClose()
              }
            }}
          />
          {(
            [
              ['matchCase', 'Match case', CaseSensitive],
              ['wholeWord', 'Match whole word', WholeWord],
              ['regex', 'Use regular expression', Regex]
            ] as const
          ).map(([key, label, Icon]) => (
            <SearchButton
              key={key}
              label={label}
              aria-pressed={query[key]}
              className={query[key] ? 'bg-accent text-accent-foreground' : undefined}
              onClick={() => onQuery({ ...query, [key]: !query[key] })}
            >
              <Icon />
            </SearchButton>
          ))}
          <SearchButton
            label="Previous match"
            disabled={!props.canNavigate}
            onClick={() => props.onNavigate(-1)}
          >
            <ChevronUp />
          </SearchButton>
          <SearchButton
            label="Next match"
            disabled={!props.canNavigate}
            onClick={() => props.onNavigate(1)}
          >
            <ChevronDown />
          </SearchButton>
          <SearchButton label="Close search" onClick={props.onClose}>
            <X />
          </SearchButton>
        </div>
        <div className="flex items-center gap-1">
          {(
            [
              ['deletions', 'Original'],
              ['additions', 'Modified']
            ] as const
          ).map(([side, label]) => (
            <Button
              key={side}
              variant="ghost"
              size="xs"
              aria-pressed={props.side === side}
              className={props.side === side ? 'bg-accent text-accent-foreground' : undefined}
              onClick={() => props.onSide(side)}
            >
              {label}
            </Button>
          ))}
          <span className="ml-auto px-1 text-xs text-muted-foreground" role="status">
            {props.status}
          </span>
        </div>
        {props.canReplace && props.replaceOpen && (
          <div className="flex items-center gap-1">
            <Input
              aria-label="Replace in diff"
              placeholder="Replace"
              value={props.replacement}
              className="h-7 min-w-0 text-xs"
              onChange={(event) => props.onReplacement(event.target.value)}
              onKeyDown={(event) => {
                if (isImeCompositionKeyDown(event)) {
                  return
                }
                if (event.key === 'Enter') {
                  event.preventDefault()
                  props.onReplace(false)
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  props.onClose()
                }
              }}
            />
            <SearchButton
              label="Replace"
              disabled={!props.canNavigate}
              onClick={() => props.onReplace(false)}
            >
              <Replace />
            </SearchButton>
            <SearchButton
              label="Replace all"
              disabled={!props.canReplaceAll}
              onClick={() => props.onReplace(true)}
            >
              <ReplaceAll />
            </SearchButton>
          </div>
        )}
      </div>
    </div>
  )
}

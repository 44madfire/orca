import { isTerminalWaitWhitespace } from './terminal-wait-tail-window'

const LINE_FEED = 10
const PERIOD = 46
const SLASH = 47
const AT_SIGN = 64
const COLON = 58
const PROMPT_CARET = 62
const BACKSLASH = 92
const TILDE = 126

/**
 * Index of the last Antigravity CLI ready screen in a normalized (lowercased) terminal tail, or null.
 * Returns the header index — not the caret — so a dialog drawn under the header still outranks it.
 */
export function findAntigravityReadyPromptIndex(normalized: string): number | null {
  const headerIndex = normalized.lastIndexOf('antigravity cli')
  if (headerIndex === -1) {
    return null
  }
  let lineStart = headerIndex
  let promptFound = false
  let geminiModelFound = false
  let pairedModelFound = false
  let accountFound = false
  let previousLineIsPlain = false

  // Why: ready previews can include echoed paste after the header; scan line bounds directly instead of splitting the whole tail.
  for (let cursor = headerIndex; cursor <= normalized.length; cursor += 1) {
    if (cursor < normalized.length && normalized.charCodeAt(cursor) !== LINE_FEED) {
      continue
    }
    let trimmedStart = lineStart
    let trimmedEnd = cursor
    while (trimmedStart < trimmedEnd && isTerminalWaitWhitespace(normalized, trimmedStart)) {
      trimmedStart += 1
    }
    while (trimmedEnd > trimmedStart && isTerminalWaitWhitespace(normalized, trimmedEnd - 1)) {
      trimmedEnd -= 1
    }
    if (lineStart > headerIndex && trimmedStart < trimmedEnd) {
      const isPromptLine =
        trimmedEnd - trimmedStart === 1 && normalized.charCodeAt(trimmedStart) === PROMPT_CARET
      const isPathLine = isWorkspacePathLine(normalized, trimmedStart, trimmedEnd)
      const isAccount =
        !isPromptLine && !isPathLine && isAccountLine(normalized, trimmedStart, trimmedEnd)
      promptFound = promptFound || isPromptLine
      accountFound = accountFound || isAccount
      pairedModelFound = pairedModelFound || (isPathLine && previousLineIsPlain)
      // Why the 'gemini' arm survives: it was the whole model test before, so keeping it makes the
      // accepted set a superset and no session that used to reach ready can stop reaching it.
      geminiModelFound =
        geminiModelFound || (!isPromptLine && normalized.startsWith('gemini', trimmedStart))
      previousLineIsPlain = !isPromptLine && !isPathLine && !isAccount
      // Why exit early: the verdict is monotonic, and the remaining tail can be megabytes of narration.
      if (isAntigravityReady(promptFound, geminiModelFound, pairedModelFound, accountFound)) {
        return headerIndex
      }
    }
    lineStart = cursor + 1
  }

  return isAntigravityReady(promptFound, geminiModelFound, pairedModelFound, accountFound)
    ? headerIndex
    : null
}

// Why the account row too: the model/workspace pairing alone also describes a startup dialog that
// prints the folder it is asking about, and a dialog whose wording is outside the blocked-signal
// vocabulary (sign-in, model picker, privacy notice) would then read as ready and be typed into.
// Only the real ready screen shows the signed-in account, so failing closed here costs a timeout.
function isAntigravityReady(
  promptFound: boolean,
  geminiModelFound: boolean,
  pairedModelFound: boolean,
  accountFound: boolean
): boolean {
  return promptFound && (geminiModelFound || (pairedModelFound && accountFound))
}

// Why the workspace line and not the model's own text: Antigravity is not Gemini-only, so the model
// name has no stable prefix -- but it always sits directly above the workspace path.
function isWorkspacePathLine(normalized: string, start: number, end: number): boolean {
  const first = normalized.charCodeAt(start)
  if (first === TILDE || first === SLASH) {
    return true
  }
  const afterDrive = normalized.charCodeAt(start + 2)
  return (
    end - start > 2 &&
    normalized.charCodeAt(start + 1) === COLON &&
    (afterDrive === BACKSLASH || afterDrive === SLASH)
  )
}

// The signed-in account row: email-shaped, and the one other line that can sit above the workspace path.
function isAccountLine(normalized: string, start: number, end: number): boolean {
  for (let cursor = start; cursor < end; cursor += 1) {
    if (normalized.charCodeAt(cursor) !== AT_SIGN) {
      continue
    }
    for (let dot = cursor + 1; dot < end; dot += 1) {
      if (normalized.charCodeAt(dot) === PERIOD) {
        return true
      }
    }
    return false
  }
  return false
}

// @vitest-environment happy-dom
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let terminal: Terminal
let view: HTMLElement
let assignedWidths: WeakMap<CSSStyleDeclaration, string>

function compose(text: string): HTMLElement {
  const textarea = terminal.textarea!
  textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
  textarea.value = text
  const update = new CompositionEvent('compositionupdate', { bubbles: true })
  Object.defineProperty(update, 'data', { value: text })
  textarea.dispatchEvent(update)
  return view.querySelector<HTMLElement>('.xterm-composition-preedit')!
}

function write(text: string): Promise<void> {
  return new Promise((resolve) => terminal.write(text, resolve))
}

describe('IME preedit advances on the terminal cell grid (#19315)', () => {
  beforeEach(() => {
    assignedWidths = new WeakMap()
    const setWidth = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'width')!.set!
    // happy-dom drops calc(var(...)); Electron coverage checks the resulting layout.
    vi.spyOn(CSSStyleDeclaration.prototype, 'width', 'set').mockImplementation(
      function (this: CSSStyleDeclaration, value) {
        assignedWidths.set(this, value)
        setWidth.call(this, value)
      }
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 6.5 })
    } as unknown as CanvasRenderingContext2D)
    const container = document.createElement('div')
    document.body.appendChild(container)
    terminal = new Terminal({ cols: 80, rows: 24, fontSize: 13, allowProposedApi: true })
    terminal.open(container)
    view = container.querySelector<HTMLElement>('.composition-view')!
  })

  afterEach(() => {
    terminal.dispose()
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it.each([
    'ああああああああ',
    '日本語かなカナ',
    '한글입력',
    '中文输入',
    'あ  あ',
    'ｱか\u3099カタカナ・コーヒー',
    '𠮷あ'
  ])('uses the same character grouping and advances as committed %s', async (text) => {
    terminal.loadAddon(new Unicode11Addon())
    terminal.unicode.activeVersion = '11'
    await write(text)
    const line = terminal.buffer.active.getLine(0)!
    const committed: string[] = []
    for (let column = 0; column < terminal.buffer.active.cursorX; column++) {
      const cell = line.getCell(column)!
      if (cell.getWidth() > 0) {
        committed.push(cell.getChars())
      }
    }
    const preedit = compose(text)
    expect(preedit.style.whiteSpace).toBe('pre')
    expect(preedit.textContent).toBe(`‎${text}‎`)
    expect(Array.from(preedit.children)).toHaveLength(committed.length)
    for (const [index, cell] of Array.from(preedit.children).entries()) {
      expect(cell.textContent).toBe(committed[index])
    }
    expect(assignedWidths.get(preedit.style)).toBe(
      `calc(var(--xterm-composition-cell-width) * ${terminal.buffer.active.cursorX})`
    )
  })

  it.each([
    'سلام',
    'क्षि',
    '👩‍💻',
    '🇯🇵',
    'a\u00adb',
    'あ\u200dあ',
    'あ\nあ',
    'abc  XYZ',
    'Aあｱe\u0301か\u3099Z',
    'あ=>',
    'ᄀ가',
    '\u3099あ'
  ])('preserves browser shaping and control handling for %s', (text) => {
    const preedit = compose(text)
    expect(preedit.textContent).toBe(`‎${text}‎`)
    expect(preedit.childNodes).toHaveLength(1)
    expect(preedit.style.width).toBe('')
    expect(preedit.style.whiteSpace).toBe('')
  })

  it('honors the active Unicode provider when a joined character widens its base', async () => {
    terminal.unicode.register({
      version: 'test-joined',
      wcwidth: () => 1,
      charProperties: (codepoint: number, preceding: number) =>
        codepoint === 0x3099 && preceding ? (2 << 1) | 1 : 1 << 1
    })
    terminal.unicode.activeVersion = 'test-joined'
    await write('か\u3099あ')
    expect(terminal.buffer.active.cursorX).toBe(3)

    const preedit = compose('か\u3099あ')

    expect(Array.from(preedit.children, (cell) => cell.textContent)).toEqual(['か\u3099', 'あ'])
    expect(assignedWidths.get(preedit.style)).toBe('calc(var(--xterm-composition-cell-width) * 3)')
  })

  it('updates advances on a renderer resize without rebuilding the composing glyphs', () => {
    const core = (
      terminal as unknown as {
        _core: {
          _renderService: { dimensions: { css: { cell: { width: number } } } }
          _compositionHelper: { updateCompositionElements: (dontRecurse: boolean) => void }
        }
      }
    )._core
    core._renderService.dimensions.css.cell.width = 6
    const preedit = compose('あい')
    const children = Array.from(preedit.children)
    expect(view.style.getPropertyValue('--xterm-composition-cell-width')).toBe('6px')

    core._renderService.dimensions.css.cell.width = 6.5
    core._compositionHelper.updateCompositionElements(true)

    expect(view.style.getPropertyValue('--xterm-composition-cell-width')).toBe('6.5px')
    expect(Array.from(preedit.children)).toEqual(children)
  })

  it('keeps provisional text out of the PTY and commits exactly once', async () => {
    const sent: string[] = []
    terminal.onData((data) => sent.push(data))
    const text = 'aあe\u0301'
    compose(text)
    expect(sent).toEqual([])

    terminal.textarea!.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: text })
    )
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(sent).toEqual([text])
    expect(view.children).toHaveLength(0)
  })
})

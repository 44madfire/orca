import type { MarkdownParseHelpers, MarkdownParseResult, MarkdownToken } from '@tiptap/core'
import { Paragraph } from '@tiptap/extension-paragraph'

type ParagraphMarkdownParser = (
  token: MarkdownToken,
  helpers: MarkdownParseHelpers
) => MarkdownParseResult

const baseParseMarkdown = Paragraph.config.parseMarkdown as ParagraphMarkdownParser

export const RichMarkdownParagraph = Paragraph.extend({
  parseMarkdown: (token, helpers) => {
    const tokens = token.tokens ?? []
    // Why: upstream hoists a lone image out of its paragraph, which produces an
    // inline image node directly under `doc` now that images are inline nodes.
    if (tokens.length === 1 && tokens[0]?.type === 'image') {
      return helpers.createNode('paragraph', undefined, helpers.parseInline(tokens))
    }
    return baseParseMarkdown(token, helpers)
  }
})

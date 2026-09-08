import { RichMarkdownExtension } from './rich-markdown-extension'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

export function createIsolatedMarkdownExtensionForTests() {
  return RichMarkdownExtension.configure({
    marked: createRichMarkdownEditorCodec().marked,
    markedOptions: { gfm: true }
  })
}

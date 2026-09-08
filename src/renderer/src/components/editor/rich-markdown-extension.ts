import { Markdown } from '@tiptap/markdown'

export const RichMarkdownExtension = Markdown.extend({
  onBeforeCreate(event) {
    this.parent?.(event)
    // Empty Markdown must initialize without routing through the HTML DOM parser.
    if (
      this.editor.options.contentType === 'markdown' &&
      typeof this.editor.options.content === 'string'
    ) {
      this.editor.options.content = this.editor.schema.topNodeType.createAndFill()!.toJSON()
    }
  }
})

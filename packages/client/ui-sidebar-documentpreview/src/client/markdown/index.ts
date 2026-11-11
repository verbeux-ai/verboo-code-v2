/** Builtin Markdown metadata and keyed document-body registration. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { fileAddressFor, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import type {} from '../index.ts'
import type { DocumentPreviewDefinition } from '../document/registry.ts'
import { MarkdownBody, type MarkdownBodyInjected } from './MarkdownBody.tsx'
import { en, ja, es, fr, de, ru, pt, zh } from './locales.ts'
// Type-only: the optional `ctx.externalLinks` service merge read below.
import type {} from '@deepseek-ai/dsh-client-external-links/client'

/** Implementation identity shared by metadata and the document slot. */
export const MARKDOWN_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown'

/**
 * Describe the Markdown implementation without taking ownership of loading.
 * @param title - locale-owned implementation name.
 * @returns builtin Markdown registration metadata.
 */
export function markdownDefinition(title: () => string): DocumentPreviewDefinition {
  return { id: MARKDOWN_BODY_ID, extensions: ['md', 'markdown'], priority: 'builtin', title, loading: 'text-pages', wrap: false }
}

/**
 * Register locale, metadata, and the document body for the owning plugin lifetime.
 * @param ctx - plugin context carrying locale, document registry, and slots.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind('documentMarkdown')
  ctx.effect(() => ctx.locale.register('documentMarkdown', { zh, en, ja, es, fr, de, ru, pt }), 'document-markdown: dictionaries')
  ctx.effect(() => ctx.documentPreviews.register(markdownDefinition(() => t('viewer.label'))), 'document-markdown: metadata')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
    {
      name: 'sidebar.right.tab.document', key: MARKDOWN_BODY_ID, locale: 'documentMarkdown',
      // A previewed document is prose with links; they leave through the product
      // link service even though no conversation owns this tab.
      inject: (sessionId: SessionId): MarkdownBodyInjected => ({
        openExternalLink: (url) => { void ctx.get('externalLinks')?.open(url) },
        // A relative Markdown link opens beside the document, in this Session.
        openFile: (path, options) => {
          const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
          const address = fileAddressFor(sessionId, cwd, resolveWorkspacePath(undefined, path))
          if (options?.line === undefined) ctx.sidebarRight.openResource(address)
          else ctx.sidebarRight.openResource(address, { params: { line: options.line } })
        },
      }),
    }, MarkdownBody,
  )), 'document-markdown: body')
}

import { resolveLink, type NoteIndex } from './notes'

export const WIKI_SCHEME = 'brain:'
export const WIKI_DEAD = 'brain-dead:'

/** Strip a leading YAML frontmatter block. */
export function stripFrontmatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

const escapeLabel = (s: string) => s.replace(/([[\]()\\])/g, '\\$1')

/**
 * Rewrite [[wikilink#heading|alias]] into standard markdown links carrying a
 * custom scheme, so react-markdown renders them and the <a> handler can
 * intercept clicks. Unresolvable targets get the "dead" scheme (rendered muted).
 * Code spans and fenced blocks are left untouched.
 */
export function rewriteWikilinks(md: string, index: NoteIndex): string {
  const parts = md.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g)
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part // code — leave alone
      return part.replace(
        /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g,
        (_m, rawTarget: string, alias?: string) => {
          const target = rawTarget.trim()
          const resolved = resolveLink(index, target)
          const label = escapeLabel((alias ?? target).trim() || target)
          const href = resolved
            ? `${WIKI_SCHEME}${encodeURIComponent(resolved)}`
            : `${WIKI_DEAD}${encodeURIComponent(target)}`
          return `[${label}](${href})`
        },
      )
    })
    .join('')
}

/** Render a frontmatter value compactly for a badge chip. */
export function fmValue(v: unknown): string {
  if (v == null) return ''
  if (Array.isArray(v)) return v.map(String).join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

function isInside(root, target) {
  const path = relative(root, target)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function encodeMarkdownPath(path) {
  return path.split(sep).map((segment) => encodeURIComponent(segment).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')
}

/** Return a Markdown-ready path only for an existing file inside the workspace. */
export async function workspaceImageReference(workspaceRoot, imagePath) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '' || typeof imagePath !== 'string' || imagePath.trim() === '') return null

  try {
    const root = await realpath(resolve(workspaceRoot))
    const candidate = await realpath(resolve(root, imagePath))
    if (!isInside(root, candidate) || !(await stat(candidate)).isFile()) return null

    const relativePath = relative(root, candidate)
    const markdown = `![生成图片](${encodeMarkdownPath(relativePath)})`
    const reference = { path: relativePath.split(sep).join('/'), markdown }
    if (!isValidWorkspaceReference(reference)) return null
    return {
      ...reference,
      instruction: `Use this exact workspace-relative Markdown image reference in your final reply: ${markdown}\nUse only this destination; do not substitute an absolute or temporary preview location.`,
    }
  } catch {
    return null
  }
}

function isValidWorkspaceReference(reference) {
  if (typeof reference?.path !== 'string' || typeof reference.markdown !== 'string') return false
  const segments = reference.path.split('/')
  if (segments.length === 0 || segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.includes('\0'))) return false
  if (/^[a-z]:/iu.test(reference.path) || isAbsolute(segments.join(sep))) return false
  const nativePath = segments.join(sep)
  return reference.markdown === `![生成图片](${encodeMarkdownPath(nativePath)})`
}

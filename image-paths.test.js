import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { workspaceImageReference } from './image-paths.js'

const root = await mkdtemp(join(tmpdir(), 'media-studio-image-paths-'))
const workspace = join(root, 'workspace')
const outside = join(root, 'outside')
await mkdir(workspace)
await mkdir(outside)
after(async () => {
  const target = resolve(root)
  assert.ok(target.startsWith(resolve(tmpdir()) + '/'))
  assert.match(target.split('/').at(-1), /^media-studio-image-paths-/)
  await rm(target, { recursive: true, force: true })
})

test('existing workspace image produces an encoded relative Markdown reference', async () => {
  const relativePath = join('assets', 'scene (100% #1) 图 [final].png')
  const filePath = join(workspace, relativePath)
  await mkdir(join(workspace, 'assets'))
  await writeFile(filePath, Buffer.from('png'))

  const reference = await workspaceImageReference(workspace, filePath)
  const normalizedPath = relativePath.split(sep).join('/')
  assert.equal(reference.path, normalizedPath)
  assert.equal(reference.markdown, '![生成图片](assets/scene%20%28100%25%20%231%29%20%E5%9B%BE%20%5Bfinal%5D.png)')
  const [, destination] = reference.markdown.match(/^!\[[^\]]*\]\((.+)\)$/u)
  assert.equal(resolve(workspace, decodeURIComponent(destination)), resolve(filePath))
  assert.match(reference.instruction, /exact workspace-relative Markdown image reference/u)
})

test('query marks, backslashes, and newlines are encoded in POSIX filenames', { skip: sep === '\\' }, async () => {
  const fileName = 'query?part=1\\line\n.png'
  const filePath = join(workspace, fileName)
  await writeFile(filePath, Buffer.from('png'))
  const reference = await workspaceImageReference(workspace, filePath)
  assert.equal(reference.markdown, '![生成图片](query%3Fpart%3D1%5Cline%0A.png)')
  const [, destination] = reference.markdown.match(/^!\[[^\]]*\]\((.+)\)$/u)
  assert.equal(resolve(workspace, decodeURIComponent(destination)), resolve(filePath))
})

test('directories are not returned as image references', async () => {
  const directoryPath = join(workspace, 'not-an-image.png')
  await mkdir(directoryPath)
  assert.equal(await workspaceImageReference(workspace, directoryPath), null)
})

test('missing workspace image does not produce a Markdown reference', async () => {
  assert.equal(await workspaceImageReference(workspace, 'missing.png'), null)
  assert.equal(await workspaceImageReference(workspace, 'image\0.png'), null)
})

test('absolute paths outside the workspace are rejected', async () => {
  const outsideFile = join(outside, 'outside.png')
  await writeFile(outsideFile, Buffer.from('png'))
  assert.equal(await workspaceImageReference(workspace, outsideFile), null)
})

test('relative traversal and symlinks escaping the workspace are rejected', async () => {
  const outsideFile = join(outside, 'escape.png')
  await writeFile(outsideFile, Buffer.from('png'))
  await symlink(outsideFile, join(workspace, 'escape.png'))
  assert.equal(await workspaceImageReference(workspace, '../outside/escape.png'), null)
  assert.equal(await workspaceImageReference(workspace, 'escape.png'), null)
})

test('absent and blank paths do not produce a Markdown reference', async () => {
  for (const value of [undefined, null, '', '   ']) {
    assert.equal(await workspaceImageReference(workspace, value), null)
  }
})

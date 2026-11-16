import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'media-studio-tool-output-'))
const workspace = join(root, 'workspace')
const dshHome = join(root, 'dsh-home')
await mkdir(workspace)

test('model-visible image result uses workspace references and excludes preview metadata', async () => {
  const previousHome = process.env.DSH_HOME
  const previousFetch = globalThis.fetch
  process.env.DSH_HOME = dshHome
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [
      { b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf9sAAAAASUVORK5CYII=' },
      { b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf9sAAAAASUVORK5CYII=' },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } })

  try {
    const { apply } = await import('./tools.js')
    let tool
    const context = {
      tools: { register(definition) { tool = definition } },
      settings: { describe: () => [{ value: { providers: { image: {
        api: 'openai-completions', baseURL: 'https://images.example/v1', apiKeyEnv: 'TEST_IMAGE_KEY', models: [{ id: 'test-image' }],
      } } } }] },
      credentials: { async resolve() { return { value: 'test-key' } } },
      sessions: { get(id) { assert.equal(id, 'session-test'); return { id } } },
      workingDirectory: { get() { return workspace } },
      get(name) { return this[name] },
    }
    apply(context, { imageProvider: 'image' })
    const value = await tool.execute({ prompt: 'test', model: 'test-image', n: 2 }, {
      agent: { id: 'session-test' }, signal: new AbortController().signal,
    })

    assert.equal(value.media.length, 2)
    for (const image of value.media) {
      assert.equal(await stat(join(workspace, image.workspacePath)).then((entry) => entry.isFile()), true)
      assert.equal(image.markdown, `![生成图片](${image.workspacePath})`)
      assert.ok(value.summary.includes(image.markdown))
      assert.equal(Object.hasOwn(image, 'url'), false)
    }
    assert.equal(Object.hasOwn(tool.output.schema.properties.media.items.properties, 'url'), false)
    const rendered = tool.output.render({ prompt: 'test' }, value)
    assert.deepEqual(rendered, [{ type: 'text', text: value.summary }])
    assert.doesNotMatch(JSON.stringify(rendered), /\/media-studio\/files|\/Users\/|[A-Z]:\\/u)
    const presentation = tool.output.presentationMeta({ prompt: 'test' }, value)
    assert.equal(presentation.media.length, 2)
    for (const image of presentation.media) {
      assert.match(image.url, /^\/media-studio\/files\//u)
    }
  } finally {
    globalThis.fetch = previousFetch
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    const target = resolve(root)
    assert.ok(target.startsWith(resolve(tmpdir()) + '/'))
    assert.match(target.split('/').at(-1), /^media-studio-tool-output-/)
    await rm(target, { recursive: true, force: true })
  }
})

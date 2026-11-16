import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from './tools.js'

test('installation tolerates missing provider and execution reports actionable configuration error', async () => {
  let tool
  const ctx = {
    tools: { register(definition) { tool = definition } },
    settings: { describe() { return [] } },
    get(name) { return this[name] },
  }
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(tool.name, 'generate_image')
  await assert.rejects(tool.execute({ prompt: 'ocean poster' }, {}), /provider "image" is not configured or active/)
})

test('provider added after registration is resolved on execution and unknown models are rejected before credentials or network', async () => {
  let tool
  let providers = {}
  const ctx = {
    tools: { register(definition) { tool = definition } },
    settings: { describe() { return [{ value: { providers } }] } },
    get(name) { return this[name] },
  }
  apply(ctx, { imageProvider: 'custom-image' })
  providers = { 'custom-image': {
    api: 'openai-completions', baseURL: 'https://images.example/v1',
    apiKeyEnv: 'TEST_IMAGE_KEY', models: [{ id: 'available-model' }],
  } }
  await assert.rejects(tool.execute({ prompt: 'ocean poster', model: 'unknown' }, {}), /configured: available-model/)
})

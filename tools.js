/**
 * media-studio model-facing tools.
 *
 * Mounted by the bundle as `generate_image`. The tool resolves an
 * existing provider from the active DSH Settings, uses the model list declared
 * there, and saves output images in the active Session workspace. A verified
 * workspace-relative Markdown reference is returned to the model; a media-route
 * copy is retained only for the tool card preview. No provider, model catalog,
 * endpoint, or credential is duplicated in the Studio preset.
 *
 * @module dsh-media-studio/tools
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MEDIA_FILES_DIR } from './index.js'
import { workspaceImageReference } from './image-paths.js'

export const name = 'media-studio-tools'
export const inject = ['tools', 'settings', 'credentials', 'sessions', 'workingDirectory']

const GENERATE_IMAGE_DESCRIPTION =
  'Generate images using the image model configured in DSH. Saves generated images to the active Agent workspace and returns a verified, workspace-relative Markdown reference when available.'

/**
 * Resolve an existing llm-pi-ai provider directly from active DSH settings.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} providerId - existing DSH provider route id.
 * @returns {object} provider metadata and the model list from DSH configuration.
 */
function configuredImageProvider(ctx, providerId) {
  const settings = ctx.get('settings')
  if (settings === undefined) throw new Error('media-studio: DSH settings service is unavailable')
  const row = settings.describe({ redactSecrets: true }).find((entry) =>
    entry.value?.providers !== null && typeof entry.value?.providers === 'object' &&
    Object.hasOwn(entry.value.providers, providerId),
  )
  const raw = row?.value?.providers?.[providerId]
  if (raw === undefined) throw new Error(`media-studio: DSH provider ${JSON.stringify(providerId)} is not configured or active`)
  if (raw.api !== 'openai-completions') {
    throw new Error(`media-studio: DSH provider "${providerId}" uses unsupported API protocol ${JSON.stringify(raw.api)}`)
  }
  if (typeof raw.baseURL !== 'string' || !/^https?:\/\//u.test(raw.baseURL)) {
    throw new Error(`media-studio: DSH provider "${providerId}" needs an http(s) baseURL`)
  }
  if (typeof raw.apiKeyEnv !== 'string' || raw.apiKeyEnv === '') {
    throw new Error(`media-studio: DSH provider "${providerId}" does not declare an apiKeyEnv`)
  }
  const models = Array.isArray(raw.models) ? raw.models.filter((model) => typeof model?.id === 'string' && model.id !== '').map((model) => ({ id: model.id, name: model.name ?? model.id })) : []
  if (models.length === 0) throw new Error(`media-studio: DSH provider "${providerId}" has no configured models`)
  return {
    id: providerId,
    kind: 'openai-images',
    displayName: typeof raw.displayName === 'string' && raw.displayName !== '' ? raw.displayName : providerId,
    baseURL: raw.baseURL.replace(/\/+$/u, ''),
    apiKeyEnv: raw.apiKeyEnv,
    models,
  }
}

/**
 * Resolve the API key for one DSH-configured provider through credentials.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} provider - provider metadata resolved from DSH settings.
 * @returns {Promise<string>} the key.
 */
async function resolveApiKey(ctx, provider) {
  const credentials = ctx.get('credentials')
  const hit = credentials === undefined ? undefined : await credentials.resolve(provider.apiKeyEnv)
  const value = hit?.value ?? process.env[provider.apiKeyEnv]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`media-studio: provider "${provider.id}" needs credential ${provider.apiKeyEnv}; configure it in DSH Settings`)
  }
  return value
}

/**
 * Pick a model from the live model list owned by the configured DSH provider.
 * @param {object} provider - DSH provider metadata.
 * @param {string | undefined} modelId - explicit model id from the call.
 * @returns {{ provider: object, model: object }} the resolved route.
 */
function routeFor(provider, modelId) {
  const model = modelId === undefined ? provider.models[0] : provider.models.find((candidate) => candidate.id === modelId)
  if (model === undefined) {
    throw new Error(`media-studio: DSH provider "${provider.id}" has no model ${JSON.stringify(modelId)}; configured: ${provider.models.map((candidate) => candidate.id).join(', ')}`)
  }
  return { provider, model }
}

/**
 * Issue one JSON request with a bounded deadline and turn the body into a value
 * or a readable error.
 * @param {string} url - absolute URL.
 * @param {RequestInit} init - fetch options.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @param {string} label - provider label used in error text.
 * @returns {Promise<any>} parsed JSON body.
 */
async function jsonRequest(url, init, signal, label) {
  const response = await fetch(url, { ...init, signal })
  const text = await response.text()
  if (!response.ok) throw new Error(`${label} request failed (${String(response.status)}): ${text.slice(0, 400)}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} returned a non-JSON body: ${text.slice(0, 200)}`)
  }
}

/**
 * Read one binary response body.
 * @param {string} url - absolute URL.
 * @param {RequestInit} init - fetch options.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @param {string} label - provider label used in error text.
 * @returns {Promise<{ data: Uint8Array, contentType: string }>} bytes and media type.
 */
async function binaryRequest(url, init, signal, label) {
  const response = await fetch(url, { ...init, signal })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`${label} download failed (${String(response.status)}): ${text.slice(0, 300)}`)
  }
  return { data: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get('content-type') ?? '' }
}

/**
 * Guess an image media type from a URL, a content type, or the bytes.
 * @param {string} contentType - response content type.
 * @param {string} url - source URL.
 * @returns {string} one of the deployment-accepted image media types.
 */
function imageMediaType(contentType, url) {
  if (contentType.startsWith('image/')) return contentType.split(';')[0]
  const suffix = /\.(png|jpe?g|webp|gif)$/iu.exec(url)?.[1]?.toLowerCase()
  if (suffix === 'png') return 'image/png'
  if (suffix === 'webp') return 'image/webp'
  if (suffix === 'gif') return 'image/gif'
  return 'image/jpeg'
}

/**
 * Call the configured image-generation route using the tested OpenAI Images
 * request shape. `baseURL` comes from the active DSH provider settings.
 * @param {object} provider - provider metadata resolved from DSH settings.
 * @param {object} model - selected model from the DSH provider model list.
 * @param {{ prompt: string, n?: number }} args - call arguments.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @param {string} key - resolved DSH credential.
 * @returns {Promise<{ images: { data: Uint8Array, mediaType: string }[] }>} generated bytes.
 */
async function openaiImages(provider, model, args, signal, key) {
  const base = provider.baseURL.replace(/\/+$/u, '')
  const endpoint = base.endsWith('/v1') ? `${base}/images/generations` : `${base}/v1/images/generations`
  const body = await jsonRequest(
    endpoint,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: model.id,
        prompt: args.prompt,
        n: args.n ?? 1,
        response_format: 'b64_json',
      }),
    },
    signal,
    provider.displayName,
  )
  const items = Array.isArray(body?.data) ? body.data : []
  const images = []
  for (const item of items) {
    if (typeof item?.b64_json === 'string') {
      images.push({ data: new Uint8Array(Buffer.from(item.b64_json, 'base64')), mediaType: 'image/png' })
      continue
    }
    if (typeof item?.url === 'string') {
      const downloaded = await binaryRequest(item.url, {}, signal, provider.displayName)
      images.push({ data: downloaded.data, mediaType: imageMediaType(downloaded.contentType, item.url) })
    }
  }
  if (images.length === 0) throw new Error(`${provider.displayName} returned no image data: ${JSON.stringify(body).slice(0, 300)}`)
  return { images }
}

function imagePresentationMetadata(value) {
  const media = value.media.map((item) => {
    const fileName = item.workspacePath
    if (typeof fileName !== 'string' || basename(fileName) !== fileName || !/^[\da-f-]+-\d+\.(?:png|webp|gif|jpg)$/iu.test(fileName)) return item
    if (!existsSync(join(MEDIA_FILES_DIR, fileName))) return item
    return { ...item, url: `/media-studio/files/${fileName}` }
  })
  return { ...value, media }
}

/** Tool output envelope and persisted image metadata. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['provider', 'model', 'prompt', 'summary', 'media'],
  properties: {
    provider: { type: 'string' },
    model: { type: 'string' },
    prompt: { type: 'string' },
    summary: { type: 'string' },
    media: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'mediaType', 'bytes'],
        properties: {
          kind: { type: 'string', enum: ['image'] },
          workspacePath: { type: 'string', description: 'Validated path relative to the active Session workspace.' },
          markdown: { type: 'string', description: 'Ready-to-use Markdown image reference. Omitted unless the file exists inside the workspace.' },
          mediaType: { type: 'string' },
          bytes: { type: 'integer' },
        },
      },
    },
  },
}

/**
 * Register both generation tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context carrying tools.
 * @param {object | undefined} config - the preset row config.
 */
export function apply(ctx, config) {
  const providerId = typeof config?.imageProvider === 'string' && config.imageProvider !== '' ? config.imageProvider : 'image'

  ctx.tools.register({
    name: 'generate_image',
    description: `${GENERATE_IMAGE_DESCRIPTION} Uses DSH provider "${providerId}"; model ids are resolved from that provider at execution time.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: 'What to draw. Be concrete about subject, style, composition, and lighting.' },
        model: { type: 'string', description: 'Model id from the configured DSH image provider. Omit to use its first model.' },
        n: { type: 'integer', description: 'How many images to generate (1-4, default 1).' },
      },
      required: ['prompt'],
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => [{ type: 'text', text: value.summary }],
      presentationMeta: (_args, value) => imagePresentationMetadata(value),
    },
    async execute(args, exec) {
      const prompt = String(args.prompt ?? '').trim()
      if (prompt === '') throw new Error('generate_image: prompt must be a non-empty string')
      const provider = configuredImageProvider(ctx, providerId)
      const { model } = routeFor(provider, typeof args.model === 'string' ? args.model : undefined)
      const key = await resolveApiKey(ctx, provider)
      const session = exec.agent === undefined ? undefined : ctx.sessions.get(exec.agent.id)
      if (session === undefined) throw new Error('generate_image: current Agent Session is unavailable; cannot determine its working directory')
      const workspaceDirectory = ctx.workingDirectory.get(session)
      const count = Number.isInteger(args.n) ? Math.min(Math.max(args.n, 1), 4) : 1
      const images = (await openaiImages(provider, model, { prompt, n: count }, exec.signal, key)).images
      let mediaCacheAvailable = true
      try {
        await mkdir(MEDIA_FILES_DIR, { recursive: true })
      } catch {
        mediaCacheAvailable = false
      }
      const media = []
      const instructions = []
      for (const [index, image] of images.entries()) {
        const extension = image.mediaType === 'image/png' ? 'png' : image.mediaType === 'image/webp' ? 'webp' : image.mediaType === 'image/gif' ? 'gif' : 'jpg'
        const fileName = `${randomUUID()}-${String(index + 1)}.${extension}`
        const filePath = join(workspaceDirectory, fileName)
        await writeFile(filePath, image.data)
        const reference = await workspaceImageReference(workspaceDirectory, filePath)
        instructions.push(reference?.instruction ?? 'No valid workspace-local image path was verified. Do not create a Markdown image reference.')
        if (mediaCacheAvailable) {
          try {
            await writeFile(join(MEDIA_FILES_DIR, fileName), image.data)
          } catch {
            mediaCacheAvailable = false
          }
        }
        media.push({
          kind: 'image',
          ...(reference === null ? {} : { workspacePath: reference.path, markdown: reference.markdown }),
          mediaType: image.mediaType,
          bytes: image.data.byteLength,
        })
      }
      const summary = `Generated ${String(media.length)} image(s) with ${provider.displayName} · ${model.id} for: ${prompt}\n\n${instructions.join('\n\n')}`
      return { provider: provider.id, model: model.id, prompt, summary, media }
    },
  })
}

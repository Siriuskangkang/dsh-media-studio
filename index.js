/**
 * media-studio host half (package root row).
 *
 * Purpose: serve generated media bytes to the Web page. The generation tool
 * lives in `./tools.js` and is mounted by this bundle's second Loader row. This
 * root row adds the browser module and one authenticated route for the profile.
 *
 * Files are placed under `$DSH_HOME/media-studio/files` by the tools; this
 * route can only read inside that directory.
 *
 * @module dsh-media-studio
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, normalize, resolve, sep } from 'node:path'

const ROUTE_PREFIX = '/media-studio/files/'

/** Directory the tools write servable media into. */
export let MEDIA_FILES_DIR = join(process.env.DSH_HOME ?? (process.env.DSH_PROFILE_DIR ? resolve(process.env.DSH_PROFILE_DIR, '..', '..') : tmpdir()), 'media-studio', 'files')

const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

export const name = 'media-studio'
export const inject = ['webServer', 'connection']

/**
 * Reject requests the deployment does not trust, using the same browser-auth
 * policy every other plugin route uses. Without a connection service (for
 * example a bare headless composition) the route stays open, which matches the
 * rest of the web carrier.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @param {import('node:http').ServerResponse} res - response to finish.
 * @returns {boolean} whether the request was already answered with a rejection.
 */
function reject(ctx, req, res) {
  const connection = ctx.get('connection')
  if (connection === undefined) return false
  const status = connection.requestRejection(req)
  if (status === undefined) return false
  res.statusCode = status
  res.end()
  return true
}

/**
 * Resolve one request path to a file inside the media directory.
 * @param {string} rawPath - URL pathname.
 * @returns {string | undefined} absolute path, or undefined when it escapes.
 */
function resolveWithin(rawPath) {
  const name = decodeURIComponent(rawPath.slice(ROUTE_PREFIX.length))
  if (name === '' || name.includes('\0')) return undefined
  const target = resolve(join(MEDIA_FILES_DIR, normalize(name)))
  const root = resolve(MEDIA_FILES_DIR) + sep
  return target.startsWith(root) ? target : undefined
}

/**
 * Serve one media file with range support so `<video>` can seek.
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @param {import('node:http').ServerResponse} res - response to write.
 * @param {string} target - absolute file path.
 * @returns {Promise<void>} settles when the response is finished or failed.
 */
async function serveFile(req, res, target) {
  let info
  try {
    info = await stat(target)
  } catch {
    res.statusCode = 404
    res.end()
    return
  }
  if (!info.isFile()) {
    res.statusCode = 404
    res.end()
    return
  }
  const type = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream'
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
  }
  const range = req.headers.range
  if (typeof range === 'string') {
    const match = /^bytes=(\d*)-(\d*)$/u.exec(range.trim())
    if (match !== null) {
      const start = match[1] === '' ? undefined : Number(match[1])
      const end = match[2] === '' ? undefined : Number(match[2])
      const from = start ?? 0
      const to = Math.min(end ?? info.size - 1, info.size - 1)
      if (from <= to && from < info.size) {
        res.writeHead(206, {
          ...headers,
          'content-range': `bytes ${String(from)}-${String(to)}/${String(info.size)}`,
          'content-length': String(to - from + 1),
        })
        createReadStream(target, { start: from, end: to }).pipe(res)
        return
      }
      res.writeHead(416, { 'content-range': `bytes */${String(info.size)}` })
      res.end()
      return
    }
  }
  res.writeHead(200, { ...headers, 'content-length': String(info.size) })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(target).pipe(res)
}

/**
 * Register the media route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context carrying webServer.
 */
export function apply(ctx, config) {
  if (typeof config?.mediaDirectory === 'string' && config.mediaDirectory !== '') {
    MEDIA_FILES_DIR = resolve(config.mediaDirectory)
  }
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          if (reject(ctx, req, res)) return
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.statusCode = 405
            res.setHeader('allow', 'GET, HEAD')
            res.end()
            return
          }
          const target = resolveWithin(new URL(req.url ?? '/', 'http://localhost').pathname)
          if (target === undefined) {
            res.statusCode = 404
            res.end()
            return
          }
          void serveFile(req, res, target)
        },
      }),
    `media-studio: GET ${ROUTE_PREFIX}`,
  )
}

/**
 * media-studio browser half: renders the `generate_image` tool as an inline
 * gallery in the conversation. The Host tool persists presentation metadata
 * with the settled call; image bytes are loaded from the authenticated media
 * route so the chat model does not need image input support.
 *
 * @module dsh-media-studio/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-media-studio',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CSS = [
      '.dmsCard{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px;display:flex;flex-direction:column;gap:10px;max-width:720px}',
      '.dmsHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dmsTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dmsPrompt{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}',
      '.dmsGrid{display:flex;flex-wrap:wrap;gap:8px}',
      '.dmsImage{display:block;max-width:100%;max-height:420px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);cursor:zoom-in;background:var(--dsw-alias-bg-layer-2)}',
      '.dmsVideo{display:block;width:100%;max-width:640px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:#000}',
      '.dmsState{font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:6px}',
      '.dmsDot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary);animation:dmsPulse 1.1s ease-in-out infinite}',
      '@keyframes dmsPulse{0%,100%{opacity:.25}50%{opacity:1}}',
      '.dmsError{font-size:12px;color:var(--dsw-alias-state-error-primary)}',
      '.dmsLink{font-size:12px;color:var(--dsw-alias-brand-primary);text-decoration:none}',
    ].join('\n')

    /** Install the card stylesheet once, and remove it with the plugin. */
    function installStyles(ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.dmsCard = 'media-studio'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }, 'media-studio: card styles')
    }

    /** Read the settled call metadata, tolerating replay of older records. */
    function readMeta(block) {
      if (block === undefined || block === null || typeof block !== 'object') return undefined
      if ('kind' in block && block.kind !== undefined && !('meta' in block)) return undefined
      const meta = block.meta
      if (meta === null || typeof meta !== 'object') return undefined
      return meta
    }

    /** Render one generated image from the authenticated host media route. */
    function StudioImage({ item }) {
      const [failed, setFailed] = React.useState(false)
      if (typeof item.url !== 'string' || !/^\/media-studio\/files\/[\da-f-]+-\d+\.(?:png|webp|gif|jpg)$/iu.test(item.url)) {
        return h('div', { className: 'dmsState' }, `图片已保存到工作区：${item.workspacePath ?? '路径未验证'}`)
      }
      if (failed) return h('div', { className: 'dmsError' }, '图片加载失败，请确认媒体路由仍可访问。')
      return h('img', {
        className: 'dmsImage',
        src: item.url,
        alt: 'generated image',
        onError: () => setFailed(true),
        onClick: () => window.open(item.url, '_blank', 'noopener'),
      })
    }

    /** Shared card frame: heading, provider facts, prompt, body slot. */
    function Frame({ title, facts, prompt, children, error }) {
      const factsText = facts.filter((fact) => typeof fact === 'string' && fact !== '').join(' · ')
      return h('div', { className: 'dmsCard' },
        h('div', { className: 'dmsHead' },
          h('span', { className: 'dmsTitle' }, title),
          factsText === '' ? null : h('span', null, factsText),
        ),
        prompt === undefined ? null : h('div', { className: 'dmsPrompt' }, prompt),
        error === undefined ? null : h('div', { className: 'dmsError' }, error),
        children,
      )
    }

    /** `generate_image` view. */
    function ImageCallView(props) {
      const meta = readMeta(props.block)
      const running = props.phase !== 'result'
      if (running) {
        return h(Frame, { title: '生成图片…', facts: [] },
          h('div', { className: 'dmsState' }, h('span', { className: 'dmsDot' }), '模型正在绘制，完成后会自动显示'))
      }
      if (meta === undefined) return h(Frame, { title: '生成图片', facts: [] }, h('div', { className: 'dmsState' }, '没有可显示的图片'))
      const images = Array.isArray(meta.media) ? meta.media.filter((item) => item.kind === 'image') : []
      return h(Frame, {
        title: images.length > 1 ? `生成 ${String(images.length)} 张图片` : '生成图片',
        facts: [meta.provider, meta.model],
        prompt: meta.prompt,
      },
        images.length === 0
          ? h('div', { className: 'dmsState' }, '没有可显示的图片')
          : h('div', { className: 'dmsGrid' }, images.map((item, index) =>
              h(StudioImage, { key: `${String(item.url)}:${String(index)}`, item }))),
        images.length === 0 ? null : h('div', { className: 'dmsHead' }, h('span', null, '点击图片可查看原图')),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        installStyles(ctx)
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview',
          key: 'generate_image',
          locale: 'conversation',
        }, ImageCallView))
      },
    }
  },
})

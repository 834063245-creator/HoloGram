// HoloGram 3D · DS' 侧边栏入口（client-plugin 浏览器半）
// 注册到 sidebar.footer.action 列表槽，点击全屏打开 HoloGram 3D 星图（iframe 套 viewer）。
import { createElement, useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

// 发货形态：3D 视图由 DSH 在同一 origin 托管（/hologram），实时数据走同源 /hologram/api/graph
const VIEWER_PATH = '/hologram/?project='
// 默认分析项目：发货时从 DSH workspace 当前项目取；此处先留默认值
const DEFAULT_PROJECT = 'D:/HoloGramHG'

// 侧边栏 footer 入口：宽态显示文字，收起态显示图标
function HologramEntry(props: { wide: boolean }) {
  const [open, setOpen] = useState(false)
  if (!open) {
    return createElement('button', {
      title: 'HoloGram 3D 星图',
      onClick: () => setOpen(true),
      style: {
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: props.wide ? '8px 12px' : '0', height: 32, justifyContent: props.wide ? 'flex-start' : 'center',
        background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer',
        fontSize: 13, borderRadius: 6,
      },
    }, props.wide ? '3D 星图' : '🌌')
  }
  // 全屏 3D 视图：iframe 套 viewer，?project= 实时分析
  return createElement('div', {
    style: { position: 'fixed', inset: 0, zIndex: 9999, background: '#030812' },
  }, [
    createElement('button', {
      onClick: () => setOpen(false),
      style: { position: 'absolute', top: 12, right: 12, zIndex: 10, padding: '6px 12px', cursor: 'pointer' },
    }, '✕ 关闭'),
    createElement('iframe', {
      src: VIEWER_PATH + encodeURIComponent(DEFAULT_PROJECT),
      style: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none' },
    }),
  ])
}

/** 依赖注入的服务。 */
export const inject = ['slots']
/** 注册侧边栏 footer 动作 + 全屏 3D。 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'hologram-3d',
    order: 100,
    // owner 提供 { wide }，透传给组件
    inject: () => ({}),
  }, HologramEntry))
}
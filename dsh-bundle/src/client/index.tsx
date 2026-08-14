// HoloGram 3D · DS' 侧边栏入口（client-plugin 浏览器半）
// 注册到 sidebar.footer.action 列表槽，点击全屏打开 HoloGram 3D 星图（iframe 套 viewer）。
// 分析目标跟随「当前会话所在工作区」（session.cwd），不再是写死路径：点开的瞬间取
// 当前会话的 cwd 作为 ?project=；没有当前会话/取不到工作区时回退到 FALLBACK_PROJECT。
import { createElement, useState } from 'react'
import type { ClientContext, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

// 发货形态：3D 视图由 DSH 在同一 origin 托管（/hologram），实时数据走同源 /hologram/api/graph
const VIEWER_PATH = '/hologram/?project='
// 兜底项目：取不到当前会话工作区时才用（全仓 HoloGram，首次分析 ~20s）
const FALLBACK_PROJECT = 'D:/HoloGramHG'

// 运行时持有的 ClientContext（惰性取会话读面，避免 apply 阶段的注入顺序依赖）。
let appCtx: ClientContext | undefined
/** 取当前会话工作区路径；无则回退默认。 */
function resolveSessionWorkspace(): string {
  try {
    const list = appCtx?.sessions?.list as { getSnapshot(): SessionListState } | undefined
    const snap = list?.getSnapshot?.()
    const cur = snap?.current
    const cwd = cur ? snap.byId[cur]?.cwd : undefined
    if (cwd && cwd.trim().length > 0) return cwd
  } catch { /* 取不到就读不到，走回退 */ }
  return FALLBACK_PROJECT
}

// 侧边栏 footer 入口：宽态显示文字，收起态显示图标
function HologramEntry(props: { wide: boolean }) {
  const [open, setOpen] = useState(false)
  const [project, setProject] = useState<string | null>(null)
  const openViewer = () => {
    // 点开瞬间解析——跟随当时正在工作的会话工作区
    setProject(resolveSessionWorkspace())
    setOpen(true)
  }
  const closeViewer = () => { setOpen(false); setProject(null) }
  if (!open) {
    return createElement('button', {
      title: 'HoloGram 3D 星图（分析当前会话工作区）',
      onClick: openViewer,
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
      onClick: closeViewer,
      style: { position: 'absolute', top: 12, right: 12, zIndex: 10, padding: '6px 12px', cursor: 'pointer' },
    }, '✕ 关闭'),
    createElement('iframe', {
      src: VIEWER_PATH + encodeURIComponent(project ?? resolveSessionWorkspace()),
      style: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none' },
    }),
  ])
}

/** 依赖注入的服务。 */
export const inject = ['slots']
/** 注册侧边栏 footer 动作 + 全屏 3D。 */
export function apply(ctx: ClientContext): void {
  appCtx = ctx
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'hologram-3d',
    order: 100,
    // owner 提供 { wide }，透传给组件
    inject: () => ({}),
  }, HologramEntry))
}

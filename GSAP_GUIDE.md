# GSAP 动画实战指南 — vibe coder + agent 版

## 这是什么

GSAP 是个动画引擎。你告诉它"这个元素从 A 状态滑到 B 状态，花 0.3 秒"，它就帮你流畅地过渡过去。比 CSS transition 强在：
- **能控制任何数值**（位置、透明度、颜色、Three.js 里的坐标——任何 JS 变量）
- **能做复杂时间线**（先滑入、再淡出、再变色——一条线串起来）
- **不会卡**（它自己优化了渲染时机）

你的项目里已经装好了，import 就能用：
```ts
import gsap from 'gsap';
```

---

## 怎么让 agent 帮你加动画

你不需要自己写代码。对着 Chat 面板说下面这种话就行：

### 常用句式

| 你想做什么 | 对 agent 这样说 |
|-----------|---------------|
| 面板滑入滑出 | "把设置面板的开关改成 GSAP 动画，从右边滑进来 0.25s，带一点弹性回弹" |
| 按钮 hover 放大 | "工具栏按钮 hover 时用 GSAP 放大到 1.05 倍，0.1s" |
| 淡入淡出 | "状态栏文字切换时加个 0.2s 的淡入淡出" |
| 元素弹跳出现 | "check 面板的违规卡片，出现时从下面弹上来，带 stagger 依次出现" |
| 数字跳动 | "节点计数变化时用 GSAP 让数字平滑过渡" |
| 页面加载动画 | "welcome 页面的标题和按钮，加载时从透明滑上来，标题先出、按钮延迟 0.3s" |

### agent 会怎么回复

agent 会：
1. 找到对应的 `.ts` 文件
2. 写好 `import gsap from 'gsap'`
3. 找到打开/关闭的代码位置
4. 用 GSAP 替换掉 CSS transition 或直接改 style 的逻辑
5. 跑 `npm run build` 确认没炸

你不需要看懂代码，但可以要求 agent "给我看你改的关键几行"。

---

## GSAP 核心三板斧（给 agent 看的参考）

### 1. gsap.to() — 从当前状态 → 目标状态

```ts
// 面板从右边滑入
gsap.to('#settings-panel', {
  x: 0,           // 滑到 x=0（原位）
  duration: 0.3,  // 0.3 秒
  ease: 'power2.out'  // 先快后慢（最自然的缓动）
});

// 面板滑出（隐藏）
gsap.to('#settings-panel', {
  x: 400,         // 滑到右边 400px 外
  duration: 0.25,
  ease: 'power2.in'
});
```

### 2. gsap.from() — 从指定状态 → 当前状态

```ts
// 卡片从下方弹入
gsap.from('.check-section', {
  y: 30,          // 起始位置：下方 30px
  opacity: 0,     // 起始：透明
  duration: 0.4,
  ease: 'back.out(1.4)',  // 超过目标再弹回来
  stagger: 0.06   // 多个元素依次延迟 0.06s
});
```

### 3. gsap.timeline() — 把多个动画串起来

```ts
const tl = gsap.timeline();
tl.to('#overlay', { opacity: 1, duration: 0.15 })     // 先出遮罩
  .from('#panel', { x: 300, duration: 0.3, ease: 'power2.out' })  // 再滑面板
  .from('.sp-tab', { y: 10, opacity: 0, stagger: 0.05, duration: 0.2 }); // 最后弹出标签
```

---

## 你的项目里最适合加 GSAP 的地方

### 优先级 1：面板开关（立刻有感觉）

- **Chat 面板** (`chat.ts`) — 当前用 CSS transition，改成 GSAP 可以在打开时加回弹
- **设置面板** (`settings-panel.ts`) — 同上，设置面板打开时可以加 stagger
- **Check 简报** (`check.ts`) — 底部抽屉，拉上来时内容逐项弹出

### 优先级 2：交互反馈

- **按钮 hover** — 目前是 CSS `:hover`，GSAP 可以做更细腻的弹性缩放
- **节点选中高亮** — 星图里选中节点时，detail card 可以弹出来
- **搜索反馈** — 搜索失败时状态栏抖一下

### 优先级 3：加载/过渡

- **Welcome → 星图切换** — welcome 消失、星图淡入
- **模式切换** — standard/full/files 切换时做个过渡
- **Toast 通知** — 状态栏消息弹入弹出

---

## 缓动函数速查

`ease` 参数控制动画的"性格"：

| ease | 感觉 | 适合 |
|------|------|------|
| `'power2.out'` | 快起慢停，自然减速 | 面板滑入、元素出现 |
| `'power2.in'` | 慢起快停 | 面板滑出、元素消失 |
| `'back.out(1.4)'` | 超过目标再弹回 | 弹窗、卡片弹出 |
| `'elastic.out(1, 0.5)'` | 橡皮筋弹动 | 通知、吸引注意 |
| `'expo.out'` | 极快起极慢停 | 大距离移动 |
| `'none'` | 匀速 | 进度条、循环动画 |

---

## agent 注意事项

1. **GSAP 操作的是 DOM**，不是 Three.js 的 3D 对象。星图里的节点旋转/缩放用 Three.js 自己的动画循环，不要用 GSAP。
2. **但是** GSAP 可以驱动 Three.js：`gsap.to(mesh.position, { x: 10, duration: 1 })` 是合法的——GSAP 可以直接改任何 JS 对象的数值属性。
3. **import 路径**：`import gsap from 'gsap'`，不要加 `/dist/` 后缀。
4. **kill 旧动画**：面板关闭时如果还在动画中，先 `gsap.killTweensOf(target)` 杀掉旧的。
5. **Resize 监听**：如果动画用了 `x` 位移，窗口 resize 后可能需要重新算位置。

---

## 快速测试

在浏览器 Console 里直接跑：
```js
// 让整个工具栏弹一下
gsap.from('#toolbar', { y: -40, duration: 0.5, ease: 'back.out(1.7)' });

// 让所有按钮依次弹出
gsap.from('#toolbar button', { scale: 0, duration: 0.3, stagger: 0.03, ease: 'back.out(2)' });
```

看到效果就知道 GSAP 能干嘛了。

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Settings 面板 — Provider | Agent | Display | Languages | About 五个标签页。
// Provider 页已拆为 settings/ProviderPage（提供方控制台），本文件只保留
// 外壳：tab 切换、dirty 状态、保存/取消、凭据暂存（删除/清除）统一落盘。
//
// 双走查形态（增补四）：产物域源码——项目内依赖经 './host' 取宿主共享
// 真实例（子页 ConfirmDialog/PluginsPage/ProviderPage 留 bundle 域经桥
// 取用——PluginsPage 反向引用 loader 的装卸面，不随产物）。

import { getVersion } from '@tauri-apps/api/app';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderIntent } from '../../../provider/providers-doc';
import type { AppSettings, ConnectionProbe, ProviderId } from './host';
// 配方文档纯函数面（意图抽取——写盘补丁的形状真源；纯计算，不经宿主桥）
import { intentOf } from './host';
import './settings-panel.css';
// 批 1 归家：三页与作者面已是包内实现（不再经宿主面整页桥）。
import { DiagnosticPage } from './DiagnosticPage';
import {
  activationConflict,
  activationSkipped,
  ConfirmDialog,
  canvasWheelMode,
  iconHtml,
  loadSettings,
  loadSettingsWithSecrets,
  notifyAgentConfigChanged,
  onProvidersDocChange,
  panelReload,
  projectProvidersErrors,
  projectProvidersFatal,
  providersDocStatus,
  providersFilePath,
  retryProvidersPath,
  saveProvidersDoc,
  saveSettings,
  selectPreset,
  setLang,
  useCompositionStore,
  useDockStore,
  usePresetStore,
  useUpdateStore,
} from './host';
import { McpPage } from './McpPage';
import { PluginsPage } from './PluginsPage';
import { ProviderPage } from './ProviderPage';
import { compositionDir, createPresetFromTemplate, rescanPresets } from './preset-authoring';
import { persistSecrets, removeSecret } from './provider-data';
import { SkillsPage } from './SkillsPage';
import { SETTINGS_TABS, type SettingsTabId } from './settings-tabs';
import { UpdateSection } from './UpdateSection';

// 页签 id 类型的真源在 `settings-tabs.ts`（表与类型同处——加页签只动那一处）。
type Tab = SettingsTabId;

// （「语言依赖」标签页（引擎 LSP 舰队状态探测）随图谱全量退役删除，2026-09-09——
//  数据源 hologram_call(engine_status) 属引擎接线，兰台侧零引擎后无源。）

// ── 主组件 ──

/** 错误消息提取（作者动作反馈面——错误不静默，统一成一行可读文本）。 */
function errTextOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 用磁盘行表换掉面板的 providers 域——**密钥必须从内存里带过去**。
 *
 *  `loadSettings()` **永远不含 apiKey**（唯一权威在系统凭据库，localStorage 无明文，
 *  见 provider-data.ts 头注）。所以「整体替换 providers 域」= 把面板里刚回填/刚输入的
 *  Key 全部清空 ⇒ 用户看到 Key 字段莫名变空，而**关掉重开面板又恢复**
 *  （mount 的 `loadSettingsWithSecrets` 会再回填一次）——2026-09-26 真机报障
 *  「设置页有时候莫名其妙丢 key」就是这个：Key 没真丢，只是面板内存态被冲掉。
 *
 *  三条重读路径（外部手改文件 → watcher 广播 / 保存后 watcher 广播 / 「重试路径」）
 *  都经这里。只补空位：内存里没有这一行（外部新加的 provider）时保持空，交给回填。 */
function withCarriedKeys(s: AppSettings, disk: AppSettings['providers']): AppSettings {
  const carried = new Map(s.providers.map((p) => [p.name, p.apiKey]));
  return {
    ...s,
    providers: disk.map((p) => (p.apiKey ? p : { ...p, apiKey: carried.get(p.name) || '' })),
  };
}

/** 面板重读的日志接缝（日志可观测性批 2，2026-09-27）。
 *
 *  ⚡ 为什么这条不可省：事故（2026-09-27）里「面板冲键 vs 凭据库真没 Key」是判不出
 *  来的岔路口——两条重读路径此前**完全无痕**。这里把「谁触发的重读、读到哪个文件、
 *  投影几行、多少行带 Key」一次记下（Key 只记**条数**，绝不落明文）。
 *  `sections` 在面板侧拿不到（那是文件里的节数，只有装载面知道）⇒ 只报投影行数。 */
function logPanelReload(trigger: string): void {
  const st = providersDocStatus();
  const rows = loadSettings().providers;
  panelReload({
    path: providersFilePath(),
    rows: rows.length,
    errors: st.errors.map((e) => ({ name: e.name, reason: e.message })),
    fatal: st.fatal,
    empty: st.empty,
    source: st.available && st.loaded && !st.fatal && !st.empty ? 'file' : 'localStorage',
    keysCarried: {
      withKey: rows.filter((p) => (p.apiKey ?? '').trim().length > 0).length,
      total: rows.length,
    },
    trigger,
  });
}

const SettingsPanelApp: React.FC<{
  onClose: () => void;
  onSave: (() => void) | null;
}> = ({ onClose, onSave }) => {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [activeTab, setActiveTab] = useState<Tab>('provider');
  /** 内容列滚动容器（切页复位用）——`.sp-content` 是**唯一**滚动容器，而七个页是它的
   *  兄弟子件：不复位的话从长页切到短页会落在中途/被夹到末尾，读作一次跳变。 */
  const contentRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // ponytail: 本 effect 的**唯一目的**就是「activeTab 变了就复位」——body 不读它，
    // 故显式 `void` 表态（同 use-paper-focus.ts 的 `void regions;` 先例；否则
    // biome 的 useExhaustiveDependencies 会把这个依赖判为多余并建议删掉）。
    void activeTab;
    const el = contentRef.current;
    if (el) el.scrollTop = 0;
  }, [activeTab]);
  const [appVersion, setAppVersion] = useState('…');
  // S4-2：组合诊断 + preset 选择（Agent tab「组合」节——只读诊断 + 缺省选择器）
  const compositionStatus = useCompositionStore((s) => s.status);
  const compositionPatchOrigin = useCompositionStore((s) => s.patchOrigin);
  const compositionError = useCompositionStore((s) => s.error);
  const compositionDiagnostics = useCompositionStore((s) => s.resolved.diagnostics);
  const presetRoster = usePresetStore((s) => s.roster);
  const presetSelected = usePresetStore((s) => s.selected);
  /** preset 层解析失败原因（F1 捕获网：行 id 不可寻址 → 回退用户层组合）。 */
  const presetError = usePresetStore((s) => s.error);
  // ── P-1 authoring 环境（2026-09-14）：组合目录 + 作者动作 ──
  const [compositionPath, setCompositionPath] = useState('');
  const [newPresetId, setNewPresetId] = useState('');
  const [newPresetFrom, setNewPresetFrom] = useState<'standard' | 'minimal'>('standard');
  const [authoringBusy, setAuthoringBusy] = useState(false);
  const [authoringMsg, setAuthoringMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  // 第四栏「被跳过」（S6 P3b）：激活账是装配期事实（每 Agent 一份账），不进纯解析
  // 产物（resolved.diagnostics）——随组合/选择变更重取一次（诊断面，非实时面板）。
  const [activationSkips, setActivationSkips] = useState<ReturnType<typeof activationSkipped>>([]);
  const [activationConflictInfo, setActivationConflictInfo] = useState<ReturnType<typeof activationConflict>>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: compositionStatus/presetSelected 是刻意的「回看触发器」——激活账写在装配期（本面板只做回看），组合状态或选择一变就重取一次；两者非 effect 体内直接引用值（与 compose-dock 的 settingsTick 同款手法）
  useEffect(() => {
    setActivationSkips(activationSkipped());
    setActivationConflictInfo(activationConflict());
  }, [compositionStatus, presetSelected]);

  // 打开面板取一次组合目录（Rust 侧按需创建——用户第一次就能看到路径）。
  // 失败不阻断面板（作者动作会再试并报错）——「错误不静默」由动作反馈承担。
  useEffect(() => {
    let alive = true;
    compositionDir(false)
      .then((p) => {
        if (alive) setCompositionPath(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const handleOpenCompositionDir = useCallback(async () => {
    setAuthoringBusy(true);
    setAuthoringMsg(null);
    try {
      setCompositionPath(await compositionDir(true));
      setAuthoringMsg({ kind: 'ok', text: '已用系统文件管理器打开组合目录。' });
    } catch (e) {
      setAuthoringMsg({ kind: 'err', text: `打开目录失败：${errTextOf(e)}` });
    } finally {
      setAuthoringBusy(false);
    }
  }, []);

  const handleRescan = useCallback(async () => {
    setAuthoringBusy(true);
    setAuthoringMsg(null);
    try {
      await rescanPresets();
      const users = usePresetStore.getState().roster.filter((p) => !p.builtin);
      setAuthoringMsg({ kind: 'ok', text: `已重新扫描：当前发现 ${users.length} 个用户 preset。` });
    } catch (e) {
      setAuthoringMsg({ kind: 'err', text: `重新扫描失败：${errTextOf(e)}` });
    } finally {
      setAuthoringBusy(false);
    }
  }, []);

  const handleCreateFromTemplate = useCallback(async () => {
    setAuthoringBusy(true);
    setAuthoringMsg(null);
    const res = await createPresetFromTemplate(newPresetId, newPresetFrom);
    if (!res.ok) {
      setAuthoringMsg({ kind: 'err', text: res.error ?? '复制模板失败' });
      setAuthoringBusy(false);
      return;
    }
    setNewPresetId('');
    await rescanPresets();
    setAuthoringMsg({ kind: 'ok', text: `已写出模板：${res.dir}（已重扫，可直接在上方选择它）` });
    setAuthoringBusy(false);
  }, [newPresetId, newPresetFrom]);
  // ⚡ 2026-08-04 状态治理：apiKey 权威在系统加密凭据 —
  // localStorage 无明文，打开面板时异步回填密钥供表单展示。
  // ⚡ 2026-08-07 竞态修复：回填用函数式合并、只填充仍为空的 key——
  // 旧实现 restoreSecrets(loadSettings()) 的快照在用户已输入后到达，
  // 会整体覆盖 state，把刚填的 key 冲掉。
  useEffect(() => {
    let alive = true;
    loadSettingsWithSecrets()
      .then((filled) => {
        if (!alive) return;
        setSettings((s) => {
          const next = structuredClone(s);
          for (const p of next.providers) {
            if (!p.apiKey || p.apiKey.trim() === '') {
              const f = filled.providers.find((x) => x.name === p.name);
              if (f?.apiKey?.trim()) p.apiKey = f.apiKey.trim();
            }
          }
          return next;
        });
      })
      .catch(() => {
        // Key 回填失败不再静默（2026-08-29 走查）：否则已配 Key 的 provider
        // 显示空 Key 字段，用户误以为没配过。
        setSaveError('已配置 Key 回填失败——下方 Key 字段显示为空；保存前请先重开面板确认。');
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion('9.0.1'));
  }, []);

  // 更新检测状态消费 update-store（app 级单例，state/update-store.ts）——
  // 壳行 shell-update-check 的启动自动检查与面板手动检查共享同一状态面：
  // 自动检查发现的新版本，打开面板即见（不再自持 useState 各写各的）。
  // mount 即 markBadgeSeen：用户已看见，入口角标熄灭。
  // 更新卡片的渲染与进度订阅在 UpdateSection（独立成件——进度按 ~150ms 发布，
  // 整面板跟着重渲是纯浪费）。
  useEffect(() => {
    useUpdateStore.getState().markBadgeSeen();
  }, []);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  // provider 配置文件状态代数（2026-09-24 配方改文件批）：文件被外部改动
  // （人/agent 手写）→ watcher 重读 → 本计数 +1 → provider 页就地反映新行表
  // 与逐节错误（「文件改了 UI 不变」会让人以为改错了地方）。
  const [providersDocVersion, setProvidersDocVersion] = useState(0);
  /** 外部改动到达时面板有未保存暂存 ⇒ 不整体替换，只标一条提示（不冲掉用户输入）。 */
  const [docStaleHint, setDocStaleHint] = useState(false);
  useEffect(() => onProvidersDocChange(() => setProvidersDocVersion((v) => v + 1)), []);
  // Provider 页独立 dirty：与其他 tab 的全局保存互不牵连
  const [providerDirty, setProviderDirty] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [closeConfirm, setCloseConfirm] = useState(false);
  // 凭据暂存：删除 Provider / 清除 Key 只进 state，保存时才删系统凭据——
  // 用户取消/关闭面板不会丢 Key（P0 修复）。
  const [pendingDeletes, setPendingDeletes] = useState<ProviderId[]>([]);
  const [pendingClears, setPendingClears] = useState<ProviderId[]>([]);
  const [saveVersion, setSaveVersion] = useState(0);

  // ── 处理函数 ──
  // 手动落盘（2026-08-07 回退）：任何改动只进 state 并标 dirty，
  // 点「保存」才落盘 + 写系统凭据 + 重建 Agent。自动落盘曾导致设置页
  // 卡死整个软件（每次击键 saveSettings → 通知订阅者 → credential IPC 风暴），已废弃。

  const markDirty = useCallback(() => setDirty(true), []);

  /** 整体替换（添加/删除/切换等单次操作），落盘由「保存」按钮统一负责。 */
  const commit = useCallback(
    (next: AppSettings): void => {
      setSettings(next);
      markDirty();
    },
    [markDirty],
  );

  /** Provider 页专用提交：只标 providerDirty，不污染其他 tab 的全局 dirty。 */
  const commitProvider = useCallback((next: AppSettings): void => {
    setSettings(next);
    setProviderDirty(true);
  }, []);

  /** 立即落盘但不标 dirty——用于非配置类状态（如测试结果）。
   *  B4（2026-08-27）：改为「读盘 → 只改 lastTest → 写回」最小面。原实现
   *  直接落整份面板 state（saveSettings(next)），把所有未保存的
   *  baseUrl/model/maxTokens 暂存改动一并隐性提交——用户点「取消」后改动
   *  早已在盘上，「未保存的更改将丢失」的确认弹窗成了谎言。 */
  const persistProbe = useCallback((name: string, probe: ConnectionProbe): void => {
    // 面板态：只更新该 provider 的 lastTest 展示（不触碰其他暂存字段）
    setSettings((s) => ({
      ...s,
      providers: s.providers.map((p) => (p.name === name ? { ...p, lastTest: probe } : p)),
    }));
    // 磁盘：读盘-改探针-写回，暂存中的配置改动不随探针落盘
    try {
      const disk = loadSettings();
      saveSettings({
        ...disk,
        providers: disk.providers.map((p) => (p.name === name ? { ...p, lastTest: probe } : p)),
      });
    } catch (e) {
      console.warn('[settings] 测试结果落盘失败（仅面板内展示）:', e);
    }
  }, []);

  const stageDelete = useCallback(
    (name: ProviderId) => setPendingDeletes((d) => (d.includes(name) ? d : [...d, name])),
    [],
  );
  const stageClear = useCallback(
    (name: ProviderId) => setPendingClears((c) => (c.includes(name) ? c : [...c, name])),
    [],
  );
  const unstageClear = useCallback((name: ProviderId) => setPendingClears((c) => c.filter((x) => x !== name)), []);

  /* ── 关闭守卫（2026-08 UI 大清扫）────────────────────────────
   * 修复：Esc（useGlobalKeys → esc-layer）/ Ctrl+,（settings/toggle 贡献）此前
   * 直连 dock.closePanel——绕过 dirty 确认，未保存更改静默丢失。守卫注册进
   * dock-store：任何关闭路径（closePanel/togglePanel）先问守卫；dirty 时弹
   * 确认并拦截。确认后的真关闭走 forceClose（先摘守卫再关）。 */
  const dirtyRef = useRef(0); // 1 = 全局 dirty，2 = providerDirty，3 = 双
  dirtyRef.current = (dirty ? 1 : 0) | (providerDirty ? 2 : 0);
  const forceClose = useCallback(() => {
    useDockStore.getState().unregisterCloseGuard('settings');
    onClose();
  }, [onClose]);
  useEffect(() => {
    useDockStore.getState().registerCloseGuard('settings', () => {
      if (dirtyRef.current !== 0) {
        setCloseConfirm(true);
        return false; // 拦截：确认弹层已在路上
      }
      return true;
    });
    return () => {
      // 卸载兜底：确认弹层开着时面板被外力强关（如 escLayer 直调 closePanel 的
      // 历史路径已不存在，防御性保留）——守卫随面板摘除
      useDockStore.getState().unregisterCloseGuard('settings');
    };
  }, []);

  const handleClose = useCallback(() => {
    if (dirty || providerDirty) {
      setCloseConfirm(true);
      return;
    }
    forceClose();
  }, [dirty, providerDirty, forceClose]);

  /** 保存管道：落盘 + 删暂存凭据 + 写新 Key + 重建 Agent。返回是否成功。
   *  @param toSave 要持久化的 settings（缺省 = 面板 state）。添加提供方即时
   *   生效路径传入含新 provider 的 next——避免闭包读到 setSettings 前的旧快照。 */
  const runSavePipeline = useCallback(
    async (toSave?: AppSettings): Promise<boolean> => {
      const target = toSave ?? settings;
      // 0) **provider 配置写文件**（2026-09-24 配方改文件批）：意图的唯一权威是
      //    `~/.lantai/providers.yml`——先把面板里这轮连接配置改动写进去（读-改-写，
      //    保住用户手写注释），失败即中止保存（错误不静默，绝不假装保存成功）。
      //    暂存的「删除 provider」= 从文件里删掉那一节（身份即键名）。
      const kept = target.providers.filter((p) => !pendingDeletes.includes(p.name));
      const patch: Record<string, ProviderIntent> = {};
      for (const p of kept) patch[p.name] = intentOf(p);
      const docWrite = await saveProvidersDoc(patch);
      if (!docWrite.ok) {
        setSaveError(
          `provider 配置文件写入失败：${docWrite.error ?? '未知原因'}\n设置未保存——配置文件是 provider 连接配置的唯一权威。`,
        );
        return false;
      }
      // ⚡ F3（2026-09-15 审计修复）：composition 节**不在本面板的表单面内**——
      // 它由预设选择器即时持久化（selectPreset → saveSettings）。settings 是
      // 挂载期快照，整体写盘会把期间改过的 preset 选择静默回退（复现：面板开着
      // 时切 preset → 之后点保存 → 重启回到旧 preset）。写盘前从磁盘重读该节
      // （与 persistProbe 的「读盘-改-写回」同一纪律；面板不拥有它）。
      const diskComposition = loadSettings().composition;
      saveSettings(diskComposition ? { ...target, composition: diskComposition } : target);
      // 1) 先删「清除 Key / 删除 Provider」暂存的系统凭据（removeSecret 幂等、失败静默）
      for (const name of [...new Set([...pendingClears, ...pendingDeletes])]) {
        await removeSecret(name);
      }
      // 2) 再写新 Key（P0-7：写失败必须据实提示）
      const failed = await persistSecrets(target);
      if (failed.length > 0) {
        setSaveError(
          `API Key 写入系统凭据失败：${failed.join('、')}。\n设置本身已保存，但重启后这些 Key 会丢失，请重试或检查系统加密服务。`,
        );
        return false;
      }
      setPendingClears([]);
      setPendingDeletes([]);
      setLang(target.display.language);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      if (onSave) onSave();
      return true;
    },
    [settings, pendingClears, pendingDeletes, onSave],
  );
  /** 全局保存（Agent / 显示等 tab） */
  const handleSave = useCallback(async () => {
    const ok = await runSavePipeline();
    if (ok) {
      setDirty(false);
      // runSavePipeline 是全量落盘：Provider 页的暂存改动也会一并持久化，
      // 因此两个 dirty 标志必须同时复位，避免保存条/保存按钮残留假状态。
      setProviderDirty(false);
      setSaveVersion((v) => v + 1);
    }
  }, [runSavePipeline]);

  /** Provider 页独立保存 */
  const handleSaveProviders = useCallback(async () => {
    const ok = await runSavePipeline();
    if (ok) {
      setProviderDirty(false);
      setDirty(false); // 同上：全量落盘，其他 tab 的 dirty 一并复位
      setSaveVersion((v) => v + 1);
    }
  }, [runSavePipeline]);

  /** 添加提供方即时生效（2026-09-06）：next 进面板 state → 走保存管道（落盘 +
   *  写 Key）→ settings-saved 热广播。全会话立刻可选新提供方的模型。 */
  const handleAddAndPersist = useCallback(
    async (next: AppSettings, addedName: ProviderId): Promise<void> => {
      setSettings(next);
      setProviderDirty(true);
      const ok = await runSavePipeline(next);
      if (!ok) {
        // 写 Key 失败——面板保留暂存与保存条，用户可重试保存（错误不静默）
        throw new Error(`添加 Provider「${addedName}」失败：API Key 写入系统凭据出错，请检查后重试`);
      }
      setProviderDirty(false);
      setDirty(false);
      setSaveVersion((v) => v + 1);
    },
    [runSavePipeline],
  );

  const closeMsg =
    dirty && providerDirty
      ? '有未保存的设置与提供方更改，关闭后将全部丢失。确定关闭？'
      : dirty
        ? '有未保存的设置更改，关闭后将丢失。确定关闭？'
        : '有未保存的提供方更改，关闭后将丢失。确定关闭？';

  /* 边缘滚动读面（2026-09-17 立为原生功能）：**行为真源在 paper-shell 插件域**
   *（`plugins/builtin/paper-shell/edge-scroll.ts`——基准带宽/限速、灵敏度映射、
   * 缺省与夹取都在那里）。本面板只读写持久化字段 `canvas.edgeScroll`：此处两个
   * 数字是**展示区间**（滑杆 min/max 与缺省显示），越界值由读侧夹取，两处同改
   *（跨插件不可 import——插件自包含契约，见 docs/plugins/README.md）。 */
  const edgeScrollSensRaw = settings.canvas?.edgeScroll?.sensitivity;
  const edgeScrollSens =
    typeof edgeScrollSensRaw === 'number' && Number.isFinite(edgeScrollSensRaw)
      ? Math.min(2, Math.max(0.5, edgeScrollSensRaw))
      : 1;
  const edgeScrollOn = settings.canvas?.edgeScroll?.enabled !== false;
  const edgeScrollHover = settings.canvas?.edgeScroll?.hover !== false;
  const setEdgeScroll = (next: { enabled: boolean; sensitivity: number; hover: boolean }): void => {
    // 展开既有 canvas（勿整体替换——会冲掉同节其他字段，见下方滚轮行为同款收口）
    commit({ ...settings, canvas: { ...settings.canvas, wheelMode: canvasWheelMode(settings), edgeScroll: next } });
  };

  // ── 渲染 ──

  return (
    <>
      {/* 背板点击关闭（a11y：背板非交互元素本体，键盘路径走面板内按钮/Esc） */}
      {/* 无 `sp-open` 类（2026-10-15 §15 批 3）：本面板 `unmountOnClose`，只在开态
          存在 ⇒「开/关两态」是死抽象，且旧案把 `.sp-open` 写在首帧上导致入场过渡
          永不触发。入场起手式改由 CSS 的 `@starting-style` 承担（settings-panel.css）。 */}
      <div id="settings-panel-overlay" onMouseDown={handleClose} aria-hidden="true" />
      <div id="settings-panel">
        {/* 头部 */}
        <div className="sp-header">
          <span
            className="sp-title"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: 内容为 icons.ts 常量表静态 SVG + 字面量，无外部输入
            dangerouslySetInnerHTML={{ __html: iconHtml('settings', 14) + ' <span class="zh">设置</span>' }}
          />
          <button
            type="button"
            className="sp-close-btn"
            onClick={handleClose}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: icons.ts 常量表静态 SVG，无外部输入
            dangerouslySetInnerHTML={{ __html: iconHtml('close', 14) }}
          />
        </div>

        {/* 标签页 */}
        <div className="sp-tabs">
          {SETTINGS_TABS.map(({ id, icon, label }) => (
            <button
              type="button"
              key={id}
              className={`sp-tab${activeTab === id ? ' active' : ''}`}
              onClick={() => setActiveTab(id)}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: icons.ts 常量表静态 SVG + 字面量，无外部输入
              dangerouslySetInnerHTML={{ __html: iconHtml(icon, 11) + ' ' + label }}
            />
          ))}
        </div>

        {/* 内容 */}
        <div className="sp-content" ref={contentRef}>
          {/* ═══ Provider 标签页（提供方控制台）═══ */}
          <div className={`sp-tab-content${activeTab === 'provider' ? ' is-on' : ''}`} data-tab="provider">
            <ProviderPage
              settings={settings}
              onCommitProvider={commitProvider}
              onPersistProbe={persistProbe}
              onStageDelete={stageDelete}
              onStageClear={stageClear}
              onUnstageClear={unstageClear}
              pendingClears={pendingClears}
              saveVersion={saveVersion}
              providerDirty={providerDirty}
              onSaveProviders={handleSaveProviders}
              onAddAndPersist={handleAddAndPersist}
              providersDoc={{
                version: providersDocVersion,
                status: providersDocStatus(),
                path: providersFilePath(),
                projectErrors: projectProvidersErrors(),
                projectFatal: projectProvidersFatal(),
                // 外部改动（人/agent 手写文件）→ 面板重读生效行表。
                // ⚡ 有未保存的暂存时**不整体替换**（那会把用户正在敲的改动冲掉）：
                // 只标一条提示，等用户保存/放弃后随下一次广播重读。
                onReload: () => {
                  if (providerDirty) {
                    setDocStaleHint(true);
                    logPanelReload('external-change(暂存中，只标提示不替换)');
                    return;
                  }
                  setDocStaleHint(false);
                  logPanelReload('external-change');
                  // 只换 providers 一域（其余 tab 的暂存改动不牵连）；
                  // 密钥随内存带走——见 withCarriedKeys 头注
                  setSettings((s) => withCarriedKeys(s, loadSettings().providers));
                },
                staleHint: docStaleHint,
                // 通道就绪后不必重启应用：再跑一次取路径（失败从不缓存）
                onRetryPath: () => {
                  void retryProvidersPath().then(() => {
                    setDocStaleHint(false);
                    logPanelReload('retry-path');
                    setSettings((s) => withCarriedKeys(s, loadSettings().providers));
                    setProvidersDocVersion((v) => v + 1);
                  });
                },
              }}
            />
          </div>

          {/* ═══ Agent 标签页 ═══ */}
          <div className={`sp-tab-content${activeTab === 'agent' ? ' is-on' : ''}`} data-tab="agent">
            <div className="sp-section">
              <div className="sp-section-title">组合 / Composition</div>
              <div className="sp-field">
                <label className="sp-label" htmlFor="sp-preset-select">
                  Preset（行组合预设）
                </label>
                <select
                  id="sp-preset-select"
                  className="sp-input"
                  value={presetSelected}
                  onChange={(e) => {
                    const id = e.target.value;
                    // selectPreset：store 同步 + settings 持久化（S4-1a）。
                    // 装配作用域下次装配生效（新案卷即见）；壳作用域重启生效。
                    selectPreset(id);
                  }}
                >
                  {presetRoster.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.metadata?.name ?? p.id}
                      {p.patch === null ? '（损坏）' : ''}
                    </option>
                  ))}
                </select>
                <div className="sp-hint-sub">
                  生效时机：新 Agent 装配（新案卷）即用新组合（含 seam 裁剪面）；在途案卷保持创建时点的组合；
                  壳行域（shell）重启生效。
                  {presetRoster.find((p) => p.id === presetSelected)?.error
                    ? ` 当前 preset 装载失败: ${presetRoster.find((p) => p.id === presetSelected)?.error}`
                    : ''}
                </div>
                {/* F1 捕获网可见面（2026-09-15）：preset 层行 id 不可寻址时解析
                    回退用户层组合——原因必须在这里可见（旧行为：boot 期抛错只落
                    console，壳行全不 boot = 空壳）。 */}
                {presetError && (
                  <div className="sp-hint-sub" style={{ color: 'var(--warn)' }}>
                    ⚠ preset 层解析失败：{presetError}
                    ——新案卷已回退「用户层 patch + 出厂组合」；请修正行 id 或改选其它 preset。
                  </div>
                )}
              </div>
              {/* P-1 authoring 环境（2026-09-14）：单二进制下"不动源码配出一个
                  preset"的最短路径——目录按需创建 / 打开 / 复制模板 / 免重启重扫。
                  块职责边界：这里不编辑组合内容（作者的编辑器是他们的编辑器）。 */}
              <div className="sp-field">
                <label className="sp-label" htmlFor="sp-preset-newid">
                  新建 / 修改 preset（组合目录）
                </label>
                <div className="sp-hint-sub">
                  目录：<code>{compositionPath || '（读取中…）'}</code>{' '}
                  <button
                    type="button"
                    className="sp-btn-sm"
                    onClick={handleOpenCompositionDir}
                    disabled={authoringBusy}
                  >
                    打开目录
                  </button>{' '}
                  <button type="button" className="sp-btn-sm" onClick={handleRescan} disabled={authoringBusy}>
                    重新扫描
                  </button>
                </div>
                <div className="sp-hint-sub">
                  每份 preset 是组合目录下的一个子目录（`roster.patch.yml` 本体 + `preset.yml` 元数据）。
                  直接改文件后点「重新扫描」即可生效，**无需重启**。
                </div>
                <input
                  id="sp-preset-newid"
                  className="sp-input"
                  value={newPresetId}
                  placeholder="my-preset（小写字母/数字/连字符）"
                  onChange={(e) => setNewPresetId(e.target.value)}
                  disabled={authoringBusy}
                />
                <div className="sp-key-row" style={{ marginTop: 8 }}>
                  <select
                    className="sp-select"
                    value={newPresetFrom}
                    onChange={(e) => setNewPresetFrom(e.target.value === 'minimal' ? 'minimal' : 'standard')}
                    disabled={authoringBusy}
                  >
                    <option value="standard">模板：standard（注释齐全的空骨架）</option>
                    <option value="minimal">模板：minimal（现成范例）</option>
                  </select>
                  <button
                    type="button"
                    className="sp-btn-sm"
                    onClick={handleCreateFromTemplate}
                    disabled={authoringBusy || newPresetId.trim() === ''}
                  >
                    复制为模板
                  </button>
                </div>
                <div className="sp-hint-sub">
                  已存在同名 preset 时拒绝覆盖（绝不抹掉你已写的内容）；行 id 写错不会静默——选中该 preset
                  会被拒绝并说明原因。
                </div>
                {authoringMsg && (
                  <div
                    className="sp-hint-sub"
                    style={{ color: authoringMsg.kind === 'ok' ? 'var(--pass)' : 'var(--warn)' }}
                  >
                    {authoringMsg.text}
                  </div>
                )}
              </div>
              <div className="sp-field">
                <div className="sp-hint-sub">
                  用户层 patch 状态：
                  {compositionStatus === 'factory' && '出厂组合（无 patch 或被拒）'}
                  {compositionStatus === 'ok' && `已应用（来源: ${compositionPatchOrigin ?? 'roster.patch.yml'}）`}
                  {compositionStatus === 'error' && `被拒——回退出厂组合（${compositionError ?? '未知原因'}）`}
                  ；热重载已启用（改 ~/.lantai/composition/roster.patch.yml 即时生效于新装配）。
                </div>
                {/* 诊断分栏（S6 P1，2026-09-15）：「某行不见了」有三种原因，处置
                    动作各不相同——未选中（默认关，回开即得）/ 被禁用（显式关掉，
                    要改 patch）/ seam 裁剪（provider 或事件域，不是工具行）。旧实现
                    一个扁平「禁用行」栏把三者混在一起（seam id 也在里面）。 */}
                {compositionDiagnostics.disabled.length > 0 && (
                  <div className="sp-hint-sub">
                    被禁用行（{compositionDiagnostics.disabled.length}）：
                    <code>{compositionDiagnostics.disabled.join(', ')}</code>
                  </div>
                )}
                {compositionDiagnostics.unselected.length > 0 && (
                  <div className="sp-hint-sub">
                    未选中行（默认关，{compositionDiagnostics.unselected.length}）：
                    <code>{compositionDiagnostics.unselected.join(', ')}</code>
                    ——在自己的 preset（presets/&lt;id&gt;/roster.patch.yml）里对它们写 <code>disabled: false</code>{' '}
                    即回开。
                  </div>
                )}
                {compositionDiagnostics.seamCapped.length > 0 && (
                  <div className="sp-hint-sub">
                    seam 裁剪（{compositionDiagnostics.seamCapped.length}）：
                    <code>{compositionDiagnostics.seamCapped.join(', ')}</code>
                  </div>
                )}
                {/* 第四栏「被跳过」（S6 P3b）：「某行不见了」的第四种原因——插件
                    激活失败（副作用没起来，P3a 起插件可按组合懒激活）。与前三栏
                    并列但**带原因**（前三栏单因故纯 id 列表；本栏的原因才是处置
                    依据：端口被占 / 权限被拒 / 依赖服务未起…）。独占冲突也在此
                    回看（冲突时装配被拒 = fail loud，拒绝后装配者）。 */}
                {activationSkips.length > 0 && (
                  <div className="sp-hint-sub">
                    被跳过的插件（{activationSkips.length}）：
                    {activationSkips.map((s) => (
                      <div key={s.id}>
                        <code>{s.id}</code>——{s.reason}
                      </div>
                    ))}
                  </div>
                )}
                {activationConflictInfo && (
                  <div className="sp-hint-sub">
                    独占资源冲突：<code>{activationConflictInfo.resource}</code> 已被{' '}
                    <code>{activationConflictInfo.heldBy}</code> 持有——
                    <code>{activationConflictInfo.rejected}</code> 的装配被拒绝。
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ═══ 显示标签页 ═══ */}
          <div className={`sp-tab-content${activeTab === 'display' ? ' is-on' : ''}`} data-tab="display">
            {/* 语言选项已摘除（2026-08 UI 大清扫：i18n 只覆盖已退役的观测台图例，
                纸面全硬编码中文——假选项误导用户。真有多语言需求时再恢复）。 */}
            <div className="sp-section" style={{ marginTop: 18 }}>
              <div className="sp-section-title">字体缩放 / Font Scale</div>
              {/* 2026-09-01 三轴面审：原生滑杆回归立法件（sp-slider-row/sp-range——
                  墨规线 + 方形墨钮，--pct 驱动填充）。旧内联 accentColor indigo
                  压过样式表「原生控件压回墨色」立法，渲染成系统蓝，退役。 */}
              <div className="sp-slider-row">
                <input
                  type="range"
                  name="fontScale"
                  className="sp-range"
                  min={0.8}
                  max={2.0}
                  step={0.05}
                  value={settings.display.fontScale}
                  style={{ '--pct': `${((settings.display.fontScale - 0.8) / 1.2) * 100}%` } as React.CSSProperties}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    commit({ ...settings, display: { ...settings.display, fontScale: v } });
                  }}
                />
                <span className="sp-slider-end">{settings.display.fontScale.toFixed(2)}x</span>
              </div>
            </div>
            <div className="sp-hint">缩放所有界面文字。更改后保存即生效（Terminal / 编辑器需重新打开文件）。</div>
            {/* 画布滚轮行为（2026-09-08 缩放舒适度拍板）：Miro 派（滚轮平滚视角）
                vs Whimsical 派（滚轮缩放画布）二选一——另一操作恒有
                Ctrl+滚轮 / 右上浮件缩放控件 / 键盘 +−0 兜底。保存后即时生效
               （视口域订阅保存广播）。 */}
            <div className="sp-section" style={{ marginTop: 18 }}>
              <div className="sp-section-title">画布 / Canvas</div>
              <div className="sp-field">
                <label className="sp-label" htmlFor="sp-canvas-wheel">
                  滚轮行为
                </label>
                <select
                  id="sp-canvas-wheel"
                  className="sp-input"
                  value={canvasWheelMode(settings)}
                  onChange={(e) => {
                    // ⚠ 展开既有 canvas：整体替换会冲掉同节其他字段（2026-09-17 边缘滚动
                    // 加入同节时暴露——滚轮行为一改，用户刚存的 edgeScroll 就被抹掉）
                    commit({
                      ...settings,
                      canvas: { ...settings.canvas, wheelMode: e.target.value as 'pan' | 'zoom' },
                    });
                  }}
                >
                  <option value="pan">平滚视角（Ctrl+滚轮缩放）</option>
                  <option value="zoom">缩放画布（Ctrl+滚轮同样缩放）</option>
                </select>
                <div className="sp-hint-sub">
                  平滚视角：滚轮滚动浏览会话流，缩放走 Ctrl+滚轮 / 右上浮件 −+ 控件 / 键盘 + − 0。
                  缩放画布：滚轮直接缩放，平移靠拖拽空白或流区纸面。保存后即时生效。
                </div>
              </div>
              {/* 边缘滚动（2026-09-17 立为原生功能）：RTS 缘滚同族——拖拽手势的指针
                  进入画布四缘感应带即持续平移视口（越靠边越快、指针停住也滚、越出
                  画布再快一档），拖块/拖选文字/拖纸条三族手势共用同一套。 */}
              <div className="sp-field" style={{ marginTop: 12 }}>
                <label className="sp-label sp-checkbox-label">
                  <input
                    type="checkbox"
                    checked={edgeScrollOn}
                    onChange={(e) =>
                      setEdgeScroll({ enabled: e.target.checked, sensitivity: edgeScrollSens, hover: edgeScrollHover })
                    }
                  />
                  拖拽到边缘时自动滚屏
                </label>
                <div className="sp-hint-sub">
                  拖块 / 拖选文字 / 拖纸条时，指针贴到画布四缘就持续平移视口——一次手势即可把内容送到画布
                  任意远处，不必「拖一下、滚一段、再拖一下」。关闭后用滚轮或拖空白处挪视口。
                </div>
              </div>
              {edgeScrollOn && (
                <div className="sp-field" style={{ marginTop: 12 }}>
                  <label className="sp-label sp-checkbox-label">
                    <input
                      type="checkbox"
                      checked={edgeScrollHover}
                      onChange={(e) =>
                        setEdgeScroll({ enabled: true, sensitivity: edgeScrollSens, hover: e.target.checked })
                      }
                    />
                    指针停在边缘也滚（无需按住）
                  </label>
                  <div className="sp-hint-sub">
                    {/* 字面量拼接（非 JSX 裸文本）：JSX 会把换行折成空格，中文提示里就多出「仍可 滚」这类空档 */}
                    {'RTS 式相机：什么都不用抓，鼠标停在画布边缘（约 0.1 秒）视口自己滚。光标停在正文上同样起滚' +
                      '——画布即地图；创作坞 / 小地图 / 按钮 / 输入框之上不滚；目次带右缘 40px 是缘滚跑道（贴屏最右' +
                      '照旧滚，带内导航面在它左边，读带 / 拖带不误触缘滚）；按下鼠标键让位给拖拽。不想要就取消勾选。'}
                  </div>
                </div>
              )}
              {edgeScrollOn && (
                <div className="sp-slider-row">
                  <input
                    type="range"
                    name="edgeScrollSensitivity"
                    className="sp-range"
                    min={0.5}
                    max={2}
                    step={0.1}
                    value={edgeScrollSens}
                    aria-label="边缘滚动灵敏度"
                    style={{ '--pct': `${((edgeScrollSens - 0.5) / 1.5) * 100}%` } as React.CSSProperties}
                    onChange={(e) =>
                      setEdgeScroll({ enabled: true, sensitivity: parseFloat(e.target.value), hover: edgeScrollHover })
                    }
                  />
                  <span className="sp-slider-end">{edgeScrollSens.toFixed(1)}x</span>
                </div>
              )}
              {edgeScrollOn && (
                <div className="sp-hint-sub">
                  灵敏度：整体强弱——起滚距离与滚动速度同向变化（1.0x = 基准）。保存后即时生效。
                </div>
              )}
            </div>
          </div>

          {/* ═══ 插件标签页（S4-3 安装通道）═══ */}
          <div className={`sp-tab-content${activeTab === 'plugins' ? ' is-on' : ''}`} data-tab="plugins">
            <PluginsPage />
          </div>

          {/* ═══ 技能标签页（skills-mcp-production-plan Commit 4）═══ */}
          <div className={`sp-tab-content${activeTab === 'skills' ? ' is-on' : ''}`} data-tab="skills">
            <SkillsPage />
          </div>

          {/* ═══ MCP 标签页（skills-mcp-production-plan Commit 6c）═══ */}
          <div className={`sp-tab-content${activeTab === 'mcp' ? ' is-on' : ''}`} data-tab="mcp">
            <McpPage />
          </div>

          {/* ═══ 诊断标签页（日志可观测性批 4）═══ */}
          <div className={`sp-tab-content${activeTab === 'diagnostic' ? ' is-on' : ''}`} data-tab="diagnostic">
            <DiagnosticPage />
          </div>

          {/* ═══ 关于标签页 ═══ */}
          <div className={`sp-tab-content${activeTab === 'about' ? ' is-on' : ''}`} data-tab="about">
            <div className="sp-section">
              <div className="sp-section-title">兰台 Lantai</div>
              <div className="sp-hint" style={{ marginBottom: 16 }}>
                一张纸上的 Agent 工作台 · 图谱引擎 HoloGram
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: '6px 12px', fontSize: 12 }}>
                <span style={{ color: 'var(--ink-2)' }}>版本</span>
                <span style={{ fontFamily: 'var(--f-mono)' }}>{appVersion}</span>
                <span style={{ color: 'var(--ink-2)' }}>许可</span>
                <span>MIT</span>
                <span style={{ color: 'var(--ink-2)' }}>作者</span>
                <span>Wenbing Jing</span>
              </div>
            </div>
            <UpdateSection
              currentVersion={appVersion}
              settings={settings}
              onAutoCheckChange={(enabled) => {
                commit({ ...settings, updates: { autoCheck: enabled } });
              }}
            />
          </div>
        </div>

        {saveError && (
          <div className="pp-error-banner">
            <span className="pp-error-text">{saveError}</span>
            <button type="button" className="pp-error-close" onClick={() => setSaveError('')} title="关闭">
              ✕
            </button>
          </div>
        )}

        {/* 底部 */}
        <div className="sp-footer">
          <button type="button" className="sp-btn sp-btn-cancel" onClick={handleClose}>
            取消
          </button>
          {/* Provider tab 用页内「保存 Provider」按钮，全局保存只负责其他 tab */}
          {activeTab !== 'provider' && (
            <button
              type="button"
              className={`sp-btn sp-btn-save${saved ? ' sp-btn-ok' : ''}`}
              disabled={!dirty}
              onClick={handleSave}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: icons.ts 常量表静态 SVG + 字面量，无外部输入
              dangerouslySetInnerHTML={{
                __html: saved ? iconHtml('check-circle', 11) + ' 已保存' : iconHtml('save', 11) + ' 保存',
              }}
            />
          )}
        </div>

        {/* 面板内确认（替换原生 alert/confirm） */}
        <ConfirmDialog
          open={closeConfirm}
          title="放弃未保存更改"
          message={closeMsg}
          confirmLabel="放弃并关闭"
          tone="danger"
          onConfirm={forceClose}
          onCancel={() => setCloseConfirm(false)}
        />
      </div>
    </>
  );
};

// ── 面板根（P3：DockPanel 条件挂载 — 关闭即卸载，重开从 localStorage 重读）──

export function SettingsPanel() {
  const closePanel = useDockStore((s) => s.closePanel);
  // 保存成功后只发显式事件；热切换由 main.ts → Workspace.applyAgentConfig 统一处理。
  return (
    <SettingsPanelApp
      onClose={() => closePanel('settings')}
      onSave={() => notifyAgentConfigChanged('settings-saved')}
    />
  );
}

@echo off
REM 兰台（Lantai）build wrapper — redirects TEMP to D:\tmp so Rust's proc-macro
REM server caches don't eat C: drive space. Each build leaves ~50 MB in %TEMP%.
set TEMP=D:\tmp
set TMP=D:\tmp

REM 随包件取件：office 域工具的后端二进制（officecli，约 32 MB，不入 git）。
REM 已落位且哈希相符时零网络直接通过；缺件则下载；哈希不符则拒绝——
REM 绝不把缺后端/错后端的安装包发出去（用户侧会表现为 office 工具一调就报找不到文件）。
node scripts\fetch-officecli.mjs
if errorlevel 1 (
  echo [build] officecli 取件失败，终止打包。
  exit /b 1
)

REM --config 覆盖：本地构建**不生成 updater 签名产物**。
REM   · 为什么：tauri.conf.json 的 bundle.createUpdaterArtifacts 恒为 true（发版／CI 需要
REM     .sig + latest.json，否则应用内更新静默失效）；而本机没有签名私钥密码，本地构建
REM     若走 true 会直接失败。所以本地这一侧显式覆盖为 false，两边各取所需。
REM   · 文件名刻意不叫 tauri.<平台>.conf.json——那种形态会被 tauri **自动合并**，
REM     一旦如此就会把 false 带回发版态（2026-08-25 那个 bug 的翻版）。
REM   · 要本地产出带签名的安装包：先设好 TAURI_SIGNING_PRIVATE_KEY 与
REM     TAURI_SIGNING_PRIVATE_KEY_PASSWORD，再直接跑
REM     `cargo tauri build`（不带本覆盖）。
REM ── Windows Authenticode 代码签名（可选；原理与配置见 scripts\sign-windows.ps1 头注）──
REM   只在配了 LANTAI_SIGN_* 时才追加签名配置：
REM     没配 ⇒ 不追加 ⇒ tauri.windows.conf.json 里没有签名配置 ⇒ Tauri 的 can_sign() 为假，
REM     构建行为与从前逐字一致（也因此一个 signtool 都不会去找）。
REM     配了 ⇒ 追加 src-tauri\sign.windows.conf.json（beforeBundleCommand + signCommand 都指向
REM     scripts\sign-windows.cmd）⇒ 主程序 / 引擎 / lspd / officecli / NSIS 安装包全部签名。
REM   ⚠ 签名构建要求 signtool 可被 Tauri 找到（bundler 签 bundle.resources 前会先 signtool verify）：
REM     PATH 上、注册表 Windows Kits 里、或 TAURI_WINDOWS_SIGNTOOL_PATH 指过去，三者有一即可。
set SIGN_ON=
if defined LANTAI_SIGN_THUMBPRINT set SIGN_ON=1
if defined LANTAI_SIGN_SUBJECT set SIGN_ON=1
if defined LANTAI_SIGN_PFX set SIGN_ON=1
if defined LANTAI_SIGN_COMMAND set SIGN_ON=1
set SIGN_CONFIG=
if defined SIGN_ON (
  set "PATH=%~dp0scripts;%PATH%"
  set SIGN_CONFIG=--config src-tauri/sign.windows.conf.json
  echo [build] Windows 代码签名已启用（scripts\sign-windows.ps1）
)

cargo tauri build --config src-tauri/no-updater.local.json %SIGN_CONFIG% %*

REM ── 产物完整性标签钉固（2026-10-15 事故立法，scripts\fix-product-integrity.cmd）──
REM   为什么在构建期做：外部沙箱会给工作区根目录打**常驻可继承**的 Low 强制完整性标签，
REM   目录里编译出的 exe 继承它之后，Windows 按镜像标签把进程压成 Low ⇒ 兰台从此写不进
REM   用户目录（provider 配置 / 窗口状态全报 os error 5），重启也无效。Low 进程改不动
REM   自己的标签（icacls 1299 = 缺 SeRelabelPrivilege），所以产品侧只有这里能治。
if errorlevel 1 (
  echo [build] 构建失败，终止（不钉标签）。
  exit /b 1
)
call "%~dp0scripts\fix-product-integrity.cmd"
if errorlevel 1 exit /b 1

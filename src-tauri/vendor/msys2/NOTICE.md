# Bundled MSYS2 Toolchain — Notice & Provenance

> Shell 稳定性收口（2026-08-15）：Agent shell 工具的解释器与核心 CLI 随 App 捆绑分发，
> 版本钉死，不依赖用户机器上的 Git Bash / PowerShell / cmd 环境。

## 来源

- 仓库：MSYS2 官方 `msys/x86_64`（下载源 `https://repo.msys2.org/msys/x86_64/`，2026-08-15 快照）
- 仅包含 `usr/bin` 下的可执行文件与依赖 DLL；未修改任何二进制。

## 包清单（版本 = 下载时点快照）

| 包 | 版本 | 许可 | 说明 |
|---|---|---|---|
| msys2-runtime | 3.6.10-3 | GPLv3+ | msys-2.0.dll 运行时 + cygpath/ps/kill |
| bash | 5.3.015-1 | GPLv3+ | 主解释器 |
| coreutils | 8.32-5 | GPLv3+ | ls/cat/cp/mv/rm/... |
| sed | 4.9-1 | GPLv3+ | |
| grep | 3.0-7 | GPLv3+ | |
| gawk | 5.4.1-1 | GPLv3+ | awk |
| findutils | 4.10.0-3 | GPLv3+ | find/xargs |
| diffutils | 3.12-1 | GPLv3+ | diff/cmp |
| tar | 1.35-3 | GPLv3+ | |
| gzip | 1.14-2 | GPLv3+ | |
| which | 2.25-1 | GPLv3+ | |
| libintl | 0.22.5-1 | LGPL | msys-intl-8.dll |
| libiconv | 1.19-1 | LGPL | msys-iconv-2.dll |
| libpcre | 8.45-5 | BSD-3-Clause | msys-pcre-1.dll（grep 依赖） |
| libpcre2_8 | 10.47-1 | BSD-3-Clause | msys-pcre2-8-0.dll |
| zlib | 1.3.2-1 | zlib | msys-z.dll |
| bzip2 | 1.0.8-4 | BSD-style | msys-bz2 工具 |
| xz | 5.8.3-1 | 公共领域/LGPL | xz 工具 |
| liblzma | 5.8.2-1 | 公共领域 | msys-lzma-5.dll |
| libzstd | 1.5.7-1 | BSD-3-Clause | msys-zstd-1.dll |
| gmp | 6.3.0-2 | LGPLv3/GPLv2 双许可 | msys-gmp-10.dll（gawk） |
| mpfr | 4.2.2-1 | LGPLv3 | msys-mpfr-6.dll（gawk） |
| ncurses | 6.6-2 | MIT/X11 | msys-ncursesw6.dll |
| libreadline | 8.3.003-1 | GPLv3+ | msys-readline8.dll（bash） |
| gcc-libs | 15.3.0-1 | GPLv3+ w/ GCC Runtime Library Exception | msys-gcc_s-seh-1.dll / msys-stdc++-6.dll |

## 许可声明

本项目（HoloGram，MIT）与上述二进制为**单纯聚合**（mere aggregation）：
各二进制保留自身许可，独立分发、可独立替换，未与本项目代码静态/动态链接。
GPL 组件的源码可自 MSYS2 官方仓库获取（`https://repo.msys2.org/msys/x86_64/`
对应版本 `-src` 包）。如需替换/审计，运行 `scripts/check-msys2-deps.sh`
做依赖闭包自检后整包升级。

## 升级纪律

1. 改包版本必须重跑 `scripts/check-msys2-deps.sh`（objdump 依赖闭包自检）。
2. 新增功能包前先确认 LICENSE；GPL/LGPL/BSD/zlib/MIT 均可，禁止 EPL/专有。
3. 更新上表版本号与许可列。

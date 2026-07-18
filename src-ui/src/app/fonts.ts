// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P0：字体自托管 — Tauri 离线运行必需，替代 index.html 的 Google Fonts CDN。
// 'Orbitron Variable' 为过渡依赖：旧 HUD 样式（base.css --font-hud）仍在使用，
// P5 视觉识别落地时随旧样式一并移除。

import '@fontsource-variable/fraunces/standard.css';
import '@fontsource-variable/fraunces/standard-italic.css';
import '@fontsource-variable/orbitron';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/500.css';
import '@fontsource/noto-serif-sc/500.css';
import '@fontsource/noto-serif-sc/600.css';

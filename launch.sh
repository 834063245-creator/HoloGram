#!/bin/bash
# HoloGram Launcher — strips Nix GL to avoid EGL conflicts
exec env -i \
  HOME="$HOME" \
  USER="$USER" \
  DISPLAY="${DISPLAY:-}" \
  WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-1}" \
  XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" \
  DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-}" \
  XDG_CURRENT_DESKTOP="${XDG_CURRENT_DESKTOP:-Hyprland}" \
  XDG_SESSION_TYPE="${XDG_SESSION_TYPE:-wayland}" \
  PATH="/usr/local/bin:/usr/bin:/bin" \
  /home/jingjianhua/HoloGram/src-tauri/target/release/hologram "$@"

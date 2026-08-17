MSYS2 runtime needs a /tmp directory at the POSIX root. This placeholder keeps the
directory present in the packaged Tauri resources so bash.exe does not print
"could not find /tmp, please create!" on every shell invocation.

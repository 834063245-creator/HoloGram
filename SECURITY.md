# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| Latest (桌面应用 10.1.x / 引擎 0.1.x) | :white_check_mark: |

Security patches will be released for the latest version.

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities through public GitHub issues.**

Use GitHub's private vulnerability reporting instead:

👉 **[Report a vulnerability](https://github.com/834063245-creator/HoloGram/security/advisories/new)**

Include:
- A clear description of the issue
- Steps to reproduce
- Affected versions
- Any potential mitigations you've identified

You should receive an acknowledgement within 48 hours. We will keep you updated on the progress and coordinate the disclosure timeline with you.

### Scope

Security-relevant areas of HoloGram include:

1. **Agent tool execution** — The built-in Agent can execute shell commands and read/write files. Permission escalation bugs, sandbox escapes, or privilege bypasses in the tool guard layer (permission engine / sandbox / confined fs) are critical.
2. **Engine subprocess IPC** — The shell communicates with the Rust analysis engine (`hologram-engine`) via JSON-RPC over stdio / TCP :9777. Injection vectors in IPC messages that could cause arbitrary code execution, or path/command smuggling that escapes the project boundary.
3. **Dynamic grammar loading** — `grammars/*.dll` (tree-sitter Kotlin / Markdown / TOML) and `aura.dll` are loaded at runtime via `libloading`; supply-chain attacks via compromised grammar/sdk artifacts or release attachments.
4. **Graph serialization deserialization** — Malformed JSON/SQLite graph files or `.hologram/` state (sessions, boards, goals, permissions.json) could trigger memory corruption or code execution in the native Rust layer.
5. **LLM API keys & credentials** — API keys are stored in system-encrypted credential storage (Windows DPAPI / macOS Keychain / Linux secret-tool). Any vector that leaks these keys (including through the loopback LLM proxy or logs) is in scope.

### Out of Scope

- Prompt injection or jailbreaking the LLM — these are inherent to current LLM technology and not within our control.
- Phishing or social engineering attacks against users
- Denial of service through resource exhaustion (the app is a local tool)

## Security Best Practices for Users

- **API keys**: Store only through the app's credential store; never commit keys to the repository or `.env` files.
- **Agent permissions**: Run the Agent with the minimum necessary permissions. Review before approving shell execution (Ask cards), and keep an eye on the permission mode (Ask / Auto / Yolo).
- **Constraint gates**: Use `hologram.constraints.yaml` to set pre-commit/CI gates — L5 irreversible changes cannot be silenced.
- **Graph/state files**: Treat `.hologram/` contents as untrusted project data — do not open graphs or sessions from sources you do not trust with full local privileges.
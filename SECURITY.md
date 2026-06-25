# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

HoloGram is in early development (0.x). Security patches will be released for the latest version.

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

1. **Agent tool execution** — The built-in Agent can execute shell commands and read/write files. Permission escalation bugs, sandbox escapes, or privilege bypasses in the tool guard layer are critical.
2. **Python engine subprocess** — The Rust shell communicates with the Python analysis engine via JSON-RPC over stdio. Injection vectors in IPC messages that could cause arbitrary code execution in the Python process.
3. **Tree-sitter grammar compilation** — Grammars are downloaded from GitHub and compiled with `gcc` at runtime. Supply-chain attacks via compromised grammar repositories or injection through grammar source files.
4. **Graph serialization deserialization** — Malformed JSON/MessagePack/SQLite graph files could trigger memory corruption or code execution in the native Rust layer.
5. **LLM API keys** — API keys are stored in local config with restricted file permissions. Any vector that leaks these keys is in scope.

### Out of Scope

- Prompt injection or jailbreaking the LLM — these are inherent to current LLM technology and not within our control.
- Phishing or social engineering attacks against users
- Denial of service through resource exhaustion (the app is a local tool)

## Security Best Practices for Users

- **API keys**: Store in `.env`, never commit them. The `.env` file is git-ignored by default.
- **Agent permissions**: Run the Agent with the minimum necessary permissions. Review before approving shell execution.
- **Constraint gates**: Use `hologram.constraints.yaml` to set pre-commit/CI gates — L5 irreversible changes cannot be silenced.

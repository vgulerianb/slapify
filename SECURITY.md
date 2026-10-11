# Security

Slapify is an autonomous browser agent: it drives a real browser and can log in on your behalf. That means it does several things a supply-chain scanner flags. This page explains each one, what stays on your machine, and how to report a problem.

## Reporting a vulnerability

Please report security issues privately through [GitHub Security Advisories](https://github.com/vgulerianb/slapify/security/advisories/new) rather than a public issue. Include the version (`npx slapify --version`), what you ran, and what happened.

## Programs it launches

Slapify starts other programs to do its job. Every launch passes arguments as an array (`execFile`/`spawn`), never through a shell, so text from a page, a goal or a model can't turn into a shell command.

| Program | When | Why |
| --- | --- | --- |
| `agent-browser` | Every browser run | The browser driver (installed with slapify). It controls Chrome. |
| `claude` | Only with `provider: claude-cli` | Runs model turns on your Claude subscription (`claude -p`). Its own tools are switched off. |
| `ffmpeg` | Only with `--record`, if installed | Encodes the run's video. |
| Chrome via Lighthouse | Only for performance audits, if you installed `lighthouse` | Lighthouse needs its own Chrome for accurate lab scores. |
| Your system browser | Only for `slapify login codex` | Opens the ChatGPT sign-in page. |
| `npm install -g agent-browser` | Only when you run `slapify install` | Installs the browser driver globally. |

## Network

Slapify talks only to services you configure:

- **Your LLM provider** (Anthropic, OpenAI, Google, Mistral, Groq, Ollama), or `chatgpt.com` and `auth.openai.com` for the `codex` provider.
- **Optional:** a decision model (TypeSafe, Vercel AI Gateway, OpenRouter, or OpenAI Decisions), Telegram, and Browserbase, each only if enabled in `.slapify/config.yaml`.
- **The websites the agent visits**, through the browser and the `fetch_url` tool.

There is no telemetry and no analytics.

## Credentials and secrets

- **Where they live:** credential profiles are in `.slapify/credentials.yaml`, in your project. The ChatGPT sign-in for the `codex` provider is in `~/.slapify/chatgpt-auth.json` with `0600` permissions. Nothing is uploaded anywhere by slapify itself.
- **What the model sees:** to log in with a `login-form` profile, the agent is given the username and password so it can type them, and `get_otp` hands it the current one-time code. **They are therefore sent to your LLM provider** as part of the conversation. Use a provider you trust with them, or prefer `inject` profiles (cookies and storage), which never pass through the model.
- **Logs:** passwords, fixed one-time codes and issued one-time codes are replaced with `[redacted]` in session logs and progress events.
- **Saving:** saving a profile again merges into the existing one, so a stored `totp_secret` isn't lost.

## Files

Uploads are only allowed from the uploads folder (default `.slapify/uploads`) or from files the agent downloaded in the same task; symlinks pointing outside are refused. Downloads go to their own folder under sanitized names. A page that asks the agent to upload something from elsewhere on your machine is refused.

## Stealth mode

With `browser.stealth: true`, slapify injects a small script ([`src/browser/stealth-init.js`](src/browser/stealth-init.js)) into pages it drives. It hides automation tells such as `navigator.webdriver` so sites that block headless browsers still work. It changes nothing on your machine and nothing outside the agent's own browser. Use it on sites you're allowed to automate, and respect their terms.

## Irreversible actions

Every tool declares what it can do (read, navigate, act, irreversible). Posting, sending, buying and deleting can be checked against a plain-English policy before they happen (`review:` in the config); when no reviewer can answer, the action is held, not performed. An irreversible action that already succeeded on a page is never repeated automatically.

## What the published package contains

The npm package ships the compiled JavaScript, unminified so it can be read and audited, plus the agent's rule files and the stealth script. It has no install scripts of its own.

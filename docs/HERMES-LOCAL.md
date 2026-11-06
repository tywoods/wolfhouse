# Hermes local (Wolfhouse project)

Talk to Hermes **about this repo** with full project context (`AGENTS.md` + SOUL).

> **Command status:** Hermes Desktop is the supported path in this checkout.
> The former `scripts/run-local-hermes.js` helper and its `hermes:local*` npm
> aliases are absent/retired; the Docker CLI section below is retained as
> historical recovery context and must not be treated as a working command map.
> See [`COMMAND-STATUS.md`](COMMAND-STATUS.md), [`../AGENTS.md`](../AGENTS.md),
> [`ARCHITECTURE-NORTH-STAR.md`](ARCHITECTURE-NORTH-STAR.md), and the current
> container runbook in [`HERMES-AZURE-VM.md`](HERMES-AZURE-VM.md).

## Hermes Desktop (recommended if you already use it)

**One-time sync** (copies Wolfhouse SOUL + OpenAI config into `%USERPROFILE%\.hermes`):

```powershell
cd C:\Users\tywoo\Desktop\WH
node scripts/setup-hermes-desktop.js
```

Then point Desktop at this repo:

1. **Settings → Workspace → Working Directory** → `C:\Users\tywoo\Desktop\WH`
2. Or launch Desktop on the repo:
   ```powershell
   hermes desktop --cwd "C:\Users\tywoo\Desktop\WH"
   ```
3. Start a **new chat session** (existing sessions may still use an old folder).

What loads automatically:

| File | Where | Role |
|------|--------|------|
| `AGENTS.md` | repo root | Project map (Luna, Hermes, paths) — when workspace = WH |
| `SOUL.md` | `%USERPROFILE%\.hermes\SOUL.md` | Engineering assistant persona (setup script copies from `hermes-local/`) |
| OpenAI config | `%USERPROFILE%\.hermes\config.yaml` | `gpt-4o-mini`, `chat_completions` |

Optional: use the **folder / context chip** in a chat header to scope file tools to `WH` if the UI offers it.

**You do not need** `run-local-hermes.js` or Docker if Desktop is working.

---

## Historical Docker CLI workflow (retired helper)

Historically, `scripts/run-local-hermes.js` started Hermes in Docker with:

- Repo mounted at `/workspace` (can read/search files)
- `AGENTS.md` — project map and Luna summary
- `hermes-local/SOUL.md` — engineering assistant persona
- `hermes-local/config.yaml` — OpenAI `gpt-4o-mini`, chat completions API

No Hermes Desktop or Python install required — only **Docker**.

### Historical setup example (not runnable in this checkout)

```powershell
cd C:\Users\tywoo\Desktop\WH
node scripts/run-local-hermes.js setup
```

This creates `hermes-local/.env` with `OPENAI_API_KEY` from:

1. `OPENAI_API_KEY` env var, or
2. Azure Key Vault `wh-staging-kv` / `openai-api-key` (if `az login`), or
3. Manual paste

`hermes-local/.env` is gitignored.

### Historical interactive example (not runnable in this checkout)

```powershell
node scripts/run-local-hermes.js chat
```

The former npm alias was:

```powershell
npm run hermes:local
```

Example prompts:

- "Summarize how Luna guest booking works in this repo."
- "What's the difference between staging Hermes and the Luna JS pipeline?"
- "Read docs/LUNA-GUEST-BEHAVIOR-SPEC.md and list the top 5 guest rules."

### Historical one-shot example (not runnable in this checkout)

```powershell
node scripts/run-local-hermes.js ask "What files own Luna package explanation?"
```

### Historical doctor example (not runnable in this checkout)

```powershell
node scripts/run-local-hermes.js doctor
```

## vs staging Hermes (Azure)

| | Local (this doc) | Staging ACA |
|--|------------------|-------------|
| Purpose | Understand/build the WH repo | Guest WhatsApp gateway (target) |
| Context | Full repo on disk | Must bake context into image |
| Command | `run-local-hermes.js chat` | `deploy-staging-hermes.js chat` |

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Docker pull slow | First run downloads `nousresearch/hermes-agent:latest` (~2GB) |
| No API key in the historical helper | The retired setup command shown above no longer exists; configure the supported Desktop path instead |
| `hermes: command not found` | Use the supported Hermes Desktop setup above; do not revive the retired helper from this historical section |
| PowerShell blocks npm in an archived procedure | Do not revive the retired helper; use the supported Desktop path |

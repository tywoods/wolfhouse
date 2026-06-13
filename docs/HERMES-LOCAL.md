# Hermes local (Wolfhouse project)

Talk to Hermes **about this repo** with full project context (`AGENTS.md` + SOUL).

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

## Docker CLI (alternative)

Talk to Hermes **about this repo** without Hermes Desktop. Hermes runs in Docker with:

- Repo mounted at `/workspace` (can read/search files)
- `AGENTS.md` — project map and Luna summary
- `hermes-local/SOUL.md` — engineering assistant persona
- `hermes-local/config.yaml` — OpenAI `gpt-4o-mini`, chat completions API

No Hermes Desktop or Python install required — only **Docker**.

## One-time setup

```powershell
cd C:\Users\tywoo\Desktop\WH
node scripts/run-local-hermes.js setup
```

This creates `hermes-local/.env` with `OPENAI_API_KEY` from:

1. `OPENAI_API_KEY` env var, or
2. Azure Key Vault `wh-staging-kv` / `openai-api-key` (if `az login`), or
3. Manual paste

`hermes-local/.env` is gitignored.

## Chat interactively

```powershell
node scripts/run-local-hermes.js chat
```

Or via npm:

```powershell
npm run hermes:local
```

Example prompts:

- "Summarize how Luna guest booking works in this repo."
- "What's the difference between staging Hermes and the Luna JS pipeline?"
- "Read docs/LUNA-GUEST-BEHAVIOR-SPEC.md and list the top 5 guest rules."

## One-shot question

```powershell
node scripts/run-local-hermes.js ask "What files own Luna package explanation?"
```

## Doctor

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
| No API key | `node scripts/run-local-hermes.js setup` |
| `hermes: command not found` | Use Docker path above, not native install |
| PowerShell npm blocked | Use `node scripts/run-local-hermes.js` directly |

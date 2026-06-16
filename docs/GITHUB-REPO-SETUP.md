# Private GitHub repo — laptop + Lunabox (Captain)

Single source of truth for Wolfhouse code. **Laptop (Cursor)** and **Lunabox (Captain/OpenClaw)** both pull/push here. Deploy still runs from the laptop after merge to `master`.

## One-time: create the repo (laptop)

1. On GitHub: **New repository** → name e.g. `wolfhouse` → **Private** → no README (you already have one).
2. Replace `@tywoods` in `.github/CODEOWNERS` with your GitHub username if different.
3. On your laptop in this repo:

```powershell
cd C:\Users\tywoo\Desktop\WH
git remote add origin git@github.com:YOUR_GITHUB_USER/wolfhouse.git
git push -u origin master
```

Use HTTPS if you prefer: `https://github.com/YOUR_GITHUB_USER/wolfhouse.git`

3. On GitHub → **Settings → Branches** → protect `master`:
   - Require a pull request before merging (optional but recommended)
   - Do **not** allow force pushes

4. **Settings → Collaborators** — only people who need write access.

## One-time: Lunabox deploy key

On GitHub → repo → **Settings → Deploy keys → Add deploy key**

- Title: `lunabox`
- Key: paste public key from Lunabox (below)
- Allow write access: **yes** (Captain pushes `captain/*` branches)

On Lunabox:

```bash
ssh-keygen -t ed25519 -C "lunabox-deploy" -f ~/.ssh/wolfhouse_deploy -N ""
cat ~/.ssh/wolfhouse_deploy.pub   # paste into GitHub deploy key
```

`~/.ssh/config` on Lunabox:

```
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/wolfhouse_deploy
  IdentitiesOnly yes
```

## One-time: point Lunabox at GitHub

If `/opt/wolfhouse/WH` is a stale bundle clone, refresh it:

```bash
sudo mv /opt/wolfhouse/WH /opt/wolfhouse/WH.bak.$(date +%Y%m%d%H%M%S)
sudo git clone git@github.com:YOUR_GITHUB_USER/wolfhouse.git /opt/wolfhouse/WH
sudo chown -R azureuser:azureuser /opt/wolfhouse/WH
```

If the tree already exists with history you want to keep:

```bash
cd /opt/wolfhouse/WH
git remote add origin git@github.com:YOUR_GITHUB_USER/wolfhouse.git   # if missing
git fetch origin
git branch -u origin/master master
git pull --ff-only
```

OpenClaw workspace (Captain):

```bash
openclaw config set agents.defaults.workspace /opt/wolfhouse/WH
```

## Daily workflow

| Who | Steps |
|-----|--------|
| **Captain** | `git pull` → edit `docker/hermes-staging/**` (and tests) → `git checkout -b captain/short-name` → commit → `git push -u origin captain/short-name` |
| **You (Cursor)** | `node scripts/check-repo-sync.js` → `git pull` → merge Captain branch → `npm run verify:luna-all` → commit → `git push` → deploy Hermes / Staff API |
| **Lunabox after your push** | `cd /opt/wolfhouse/WH && git pull` (Captain can do this) |

**Rule:** live `/var/lib/hermes-luna/SOUL.md` = smoke test only. Durable Luna changes live in `docker/hermes-staging/SOUL.md` in git.

## Safety check before push or deploy

```bash
node scripts/check-repo-sync.js
node scripts/check-repo-sync.js --strict   # fail if anything drifted
```

Or: `npm run check:repo-sync`

This catches “Captain pushed, laptop does not know yet” before you overwrite work.

## Staff API

GitHub does **not** deploy Staff API. Captain can read Staff API source in the monorepo but:

- `CODEOWNERS` requires your review on staff/DB paths
- Only **you** run Azure Container Apps deploy for `wh-staging-staff-api`
- Captain already has **runtime** bot access via `LUNA_BOT_INTERNAL_TOKEN` on Hermes (unchanged)

## Legacy: git bundle sync

If GitHub is unreachable, the old laptop→VM bundle path still works:

```bash
node scripts/deploy-staging-hermes-vm.js sync-repo
```

Do **not** run `sync-repo` if Lunabox has unpulled commits — run `check-repo-sync` first.

## Related

- Captain rules: `CLAUDE.md`
- Lunabox ops: `docs/HERMES-AZURE-VM.md`
- Map: `AGENTS.md`

# Earthling → finish 2F-C (email encryption key in Azure)

_Left by Captain, 2026-08-04. Read this, do the 6 steps, paste back one value. ~15 min._

## What this is (30-second version)
Luna's email feature encrypts each Microsoft refresh-token with a local AES key, then **wraps that AES key with an RSA key kept in Azure Key Vault** (so the secret never sits unprotected in Postgres). The code for this is already built and merged (2F-A + 2F-B), but it's **turned OFF** because the RSA key doesn't exist yet and the app isn't allowed to use it.

**Your job:** create that one RSA key in the existing vault, let the Sunset app use it, and paste the key's ID back. That's it. Nothing turns on until we run a custody proof afterwards.

## Fixed facts (already looked up for you)
- Subscription: `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`
- Vault: **`wh-staging-kv`** (resource group `wh-staging-rg`, Standard tier, RBAC) — **use this vault, do not make a new one.**
- Vault resource ID (used in the role commands):
  `/subscriptions/6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9/resourceGroups/wh-staging-rg/providers/Microsoft.KeyVault/vaults/wh-staging-kv`
- Sunset app's identity (needs wrap/unwrap at runtime): principalId **`5338388f-1685-40cb-ae69-dc2e00f32ad6`** (`luna-sunset-staging-identity`).

> Windows `cmd`: run each command on its own line, one at a time. Where a step says "copy the value," paste it into the next command by hand.

## Steps

**0. Log in and target the subscription**
```
az login
az account set --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9
```

**1. Give yourself permission to manage keys in the vault** (skip if `az keyvault key list --vault-name wh-staging-kv -o table` already works)
```
az ad signed-in-user show --query id -o tsv
```
Copy that value (your object id), then (wait ~1–2 min after for it to take effect):
```
az role assignment create --assignee <YOUR_OBJECT_ID> --role "Key Vault Crypto Officer" --scope /subscriptions/6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9/resourceGroups/wh-staging-rg/providers/Microsoft.KeyVault/vaults/wh-staging-kv
```

**2. See what's already in the vault** (if a suitable RSA key already exists we can reuse it — otherwise make one in step 3)
```
az keyvault key list --vault-name wh-staging-kv -o table
```

**3. Create the wrapping key** (RSA 3072, allowed to do only wrap/unwrap)
```
az keyvault key create --vault-name wh-staging-kv --name luna-email-grant-kek --kty RSA --size 3072 --ops wrapKey unwrapKey
```

**4. Get the exact versioned key ID** (this is the thing we need back)
```
az keyvault key show --vault-name wh-staging-kv --name luna-email-grant-kek --query key.kid -o tsv
```
It looks like `https://wh-staging-kv.vault.azure.net/keys/luna-email-grant-kek/<long-hex-version>`. **Copy the whole line.** This is a public identifier (safe to share) — the code pins this **exact version**, never "latest."

**5. Let the Sunset app use the key at runtime** (wrap/unwrap only — least privilege)
```
az role assignment create --assignee 5338388f-1685-40cb-ae69-dc2e00f32ad6 --role "Key Vault Crypto User" --scope /subscriptions/6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9/resourceGroups/wh-staging-rg/providers/Microsoft.KeyVault/vaults/wh-staging-kv
```

**6. Paste back**
Drop the full key ID from step 4 into the Captain thread / Journey. That unblocks the next step (wiring + a controlled staging wrap/unwrap proof). **Do not enable any email runtime** — we only prove custody first.

## If a command errors
- **"Caller is not authorized … keys/read/write"** on steps 2–4 → step 1 hasn't propagated yet, wait a minute and retry.
- **"Insufficient privileges to complete the operation"** on a `role assignment create` (steps 1 or 5) → your account needs **"Role Based Access Control Administrator"** (or "User Access Administrator") on `wh-staging-rg` or the vault. Assign yourself that first (or ask whoever owns the subscription), then retry.
- Standard vault only — **do not** pick HSM/Premium or an `A256KW` key; the code is RSA-OAEP-256 only and will reject anything else.

## What Captain does after you paste the key ID
Wire the versioned key ID into the envelope-provider config, compose the Azure SDK crypto client with the Sunset identity, and run the **staging wrap/unwrap custody proof** (seal + open a throwaway test envelope). Only if that passes do we move on to the rest of the email runtime (refresh-exchange, OAuth callback, activation) — each behind its own gate. No guest email flow before all of it is green.

_Ref: `scripts/lib/email-grant-envelope-azure-kv-provider.js` (RSA-OAEP-256, exact-version key IDs), `docs/PHASE-2f.md`._

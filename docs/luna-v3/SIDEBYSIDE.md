# Luna v3 side-by-side runner

Job `DH-V3-SIDEBYSIDE-20261023T2030`. Offline planner for the frozen acceptance scripts. It does not send WhatsApp, does not write Staff, and does not call Crow's Nest unless Chief later opts into a live run.

## Targets

| `--target` | Runtime | Crow's Nest tenant |
|---|---|---|
| `hermes-luna-clone` | Luna v3 | `luna-v3` |
| `hermes-luna` | Luna Classic (v2) | `wolfhouse` |

Sunset is rejected. Aliases: `v3`, `luna-v3`, `clone` → clone; `classic`, `v2`, `wolfhouse` → Classic.

## Dry-run (default)

```sh
node scripts/verify-luna-v3-sidebyside.js
node scripts/run-luna-v3-sidebyside.js --dry-run --target hermes-luna-clone --out tmp/luna-v3-sidebyside/clone
node scripts/run-luna-v3-sidebyside.js --dry-run --target hermes-luna --out tmp/luna-v3-sidebyside/classic
```

Dry-run loads `fixtures/luna-v3/acceptance/`, requires reserved `+34 699 9xx` phones and 2027 dates, writes one transcript per script plus `summary.json` and `scorecard.json`. `this_run.executed` is false. The safety floor is not certified. Fetch is not called.

## Live (Chief, after Skip lands v3)

```sh
LUNA_V3_SIDEBYSIDE_LIVE=1 node scripts/run-luna-v3-sidebyside.js --live --target hermes-luna-clone
```

Without that env var, `--live` refuses. Live posts to `POST /api/live-simulator/guest-turn` with `allow_writes: false` and `external_send_allowed: false`. This lane does not run live.

## Not here

No deploy, restart, send, Staff alert, production, Sunset, secret, or France login. Skip's `docker/hermes-luna-v3/` and `scripts/lib/model-led-luna/` stay untouched. Seadog's v3 docs stay untouched.

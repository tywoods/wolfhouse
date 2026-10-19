# WA code swap — operator runbook

This change is an offline candidate. It does not install, register, restart, or send.

## What changed

Wolfhouse TEST Luna, Wolfhouse Staff, and the France routing controller / Crow's Nest
no longer embed a WhatsApp phone number. The selected profile reads five variables
that the operator already placed in `/root/wa-luna-ar.env` (root:root 0600):

- `WA_PHONE_NUMBER_ID`
- `WA_BUSINESS_ACCOUNT_ID`
- `WA_APP_ID`
- `WA_ACCESS_TOKEN`
- `WA_APP_SECRET`

Consuming services load that file with compose `env_file` or systemd
`EnvironmentFile`. Application code does not read the file path and does not
read Key Vault. There is no Azure secrets SDK and no `/register` step in this
change.

## Fail closed

If any of those keys is present, the profile is active. Missing, empty,
malformed, or conflicting values stop the selected profile. They do not fall
back to an old phone, an old token, or an old vault name. Other roles are
unchanged when none of the keys are present.

Token and app secret are copied into the existing in-process adapter inputs
only. They are not written to the repository, the image, `$HERMES_HOME/.env`,
logs, or generated files. The callback verify token is a different value and
is left alone.

## Who loads what

- TEST Luna: the image hook maps the five variables into the existing Cloud API
  adapter inputs in process memory, after normal configuration loading. Bootstrap
  does not persist the token, app secret, or phone ID when the profile is active.
- Staff: `npm run staff:api:selected-whatsapp` maps the variables before
  `staff-query-api.js` starts. The existing `staff:api` script is unchanged so
  Sunset and other roles keep their start command. Do not run the selected
  start command from this job.
- France controller / Crow's Nest: public IDs only. The controller env file
  must not contain the token or app secret. See
  `deploy/luna-routing/controller.france.env.example`. Router mutations stay
  false. Delivery stays off. A stale selector cannot authorize a different
  identity.

## Holds that remain

No outbound WhatsApp. Router off. Meta callback unchanged (Ty owns it). Staff
alerts off. Sunset parked. No Lunabox action, no gateway restart, no install
script execution, and no merge until Cap passes this candidate.

Installation, image build, and any later activation are separate authorization.
Source pass does not mean the number is registered or live.

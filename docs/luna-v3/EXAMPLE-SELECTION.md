# Luna v3 real-chat example selection

This document defines how approved operators will extract, select, scrub, and package real Luna conversations for Luna v3. It contains no guest data.

## Source and access

- Use the read-only Wolfhouse Staff Inbox endpoints `/staff/conversations`, `/staff/conversations/{id}/messages`, and `/staff/conversations/{id}/context` with an approved Wolfhouse viewer account.
- Skip performs the authorized extraction. Credentials, tokens, cookies, and raw exports never enter Git, Discord, or the Luna v3 runtime.
- Engineering or planning chats are not guest training examples.

## Review and selection target

1. Review 20 real conversations.
2. Select 12 short examples covering, where the source supports them:
   - solo guest;
   - couple who want to stay together;
   - group with individual choices;
   - room clarification;
   - packages and shuttle;
   - quote and payment choice;
   - verified payment confirmation;
   - unpaid cancellation;
   - paid cancellation or change requiring human help;
   - change of mind;
   - failed operation or recovery.
3. Prefer verified good outcomes. A small number of useful failures may be included only as clearly labelled **Do not copy** counterexamples.
4. Keep enough preceding turns to explain the decision and enough outcome evidence to show what happened.
5. Cross-check booking, payment, bed, transfer, and cancellation outcomes where available. Mark an outcome `unknown` rather than inferring it.
6. Include English and Spanish only where suitable real material exists.
7. Do not select only polished happy paths. If fewer than 12 suitable conversations exist, report the shortfall; never invent examples and call them real.

## Privacy and scrubbing

Raw exports remain in restricted operator storage outside Git, chat, and the clone. Before Seadog receives any material, Skip must:

- replace names with consistent aliases;
- replace phone numbers, email addresses, street addresses, booking IDs, payment IDs, bed/record IDs, conversation IDs, exact timestamps, URLs, and tokens;
- remove personal notes and sensitive disclosures that are not needed to understand the decision;
- preserve relationships, party structure, preferences, decision context, and the verified outcome;
- retain the reversible source-ID mapping only in restricted operator storage.

Seadog manually performs a second privacy review before committing any example. No example may contain a reversible identity mapping.

## Amounts, dates, and truth

- Label historical prices and deposit amounts as illustrative history, never as current pricing.
- Luna v3 must call Staff for current availability, policy, package, transfer, deposit, and money facts.
- Runnable examples must be adapted to approved synthetic identities and 2027 dates and marked `adapted`.
- Do not invent a weekday while changing a date; calculate and verify it.
- Current Ty-approved rules and the current Staff guide override historical behavior.

## Manifest

Each selected example gets an anonymous manifest entry containing:

- anonymous example ID;
- language;
- covered scenario and selection reason;
- `good example` or `do not copy` classification;
- redactions performed;
- known outcome, or `unknown`;
- whether dates/identities were adapted;
- source-guide version and Staff-guide version.

The restricted source-ID mapping is not part of this manifest.

## Runtime use and test separation

- Put only a compact handful of examples in initial context; expose the rest as read-only reference.
- Do not retrain, self-learn from live chats, or give Luna v3 access to the raw archive.
- Keep these examples separate from frozen acceptance scripts under `fixtures/luna-v3/acceptance/`.
- Do not tune or replace acceptance scripts after observing failures.

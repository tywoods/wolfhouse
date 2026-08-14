'use strict';

/**
 * EMAIL-MATCH-001 offline gate: conversation identity + Sunset guest email match.
 */

const {
  resolveInboundConversationKey,
  registerInboundThreadAnchor,
  buildFromConversationKey,
} = require('./lib/email-inbound-conversation-identity');
const { matchSunsetGuestByInboundEmail } = require('./lib/email-inbound-guest-email-match');

const MAILBOX = '22222222-2222-4222-8222-222222222222ab';
const MAILBOX_OTHER = '33333333-3333-4333-8333-333333333333';
const FROM_A = 'Elena.Guest@Example.COM';
const FROM_B = 'other.person@example.com';
const GUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name, detail ? `— ${detail}` : '');
  }
}

console.log('verify:email-inbound-match-helpers — EMAIL-MATCH-001\n');

const firstA = resolveInboundConversationKey({
  providerMailboxId: MAILBOX,
  fromAddress: FROM_A,
});
const secondA = resolveInboundConversationKey({
  providerMailboxId: MAILBOX,
  fromAddress: '  elena.guest@example.com  ',
});
ok('same From + mailbox → same conversation key', Boolean(
  firstA
  && secondA
  && firstA.conversation_key === secondA.conversation_key
  && firstA.strategy === 'from'
));
ok('different From → different conversation key', (() => {
  const other = resolveInboundConversationKey({
    providerMailboxId: MAILBOX,
    fromAddress: FROM_B,
  });
  return Boolean(other && firstA && other.conversation_key !== firstA.conversation_key);
})());
ok('different mailbox → different conversation key', (() => {
  const otherMailbox = resolveInboundConversationKey({
    providerMailboxId: MAILBOX_OTHER,
    fromAddress: FROM_A,
  });
  return Boolean(otherMailbox && firstA && otherMailbox.conversation_key !== firstA.conversation_key);
})());

const rootMessageId = '<root-thread@mail.example>';
const childMessageId = '<child-thread@mail.example>';
const registry = new Map();
ok('register inbound thread anchor', registerInboundThreadAnchor(
  registry,
  MAILBOX,
  rootMessageId,
  firstA.conversation_key,
));
const reply = resolveInboundConversationKey({
  providerMailboxId: MAILBOX,
  fromAddress: FROM_A,
  inReplyTo: rootMessageId,
  threadAnchorKeys: registry,
});
ok('In-Reply-To joins registered thread', Boolean(
  reply
  && reply.strategy === 'thread_join'
  && reply.conversation_key === firstA.conversation_key
));

const referencesReply = resolveInboundConversationKey({
  providerMailboxId: MAILBOX,
  fromAddress: FROM_A,
  references: `${rootMessageId} ${childMessageId}`,
  threadAnchorKeys: registry,
});
ok('References newest→oldest joins first registered anchor', Boolean(
  referencesReply
  && referencesReply.strategy === 'thread_join'
  && referencesReply.conversation_key === firstA.conversation_key
  && referencesReply.thread_anchor === 'root-thread@mail.example'
));

const middleMessageId = '<middle-thread@mail.example>';
const newestMessageId = '<newest-thread@mail.example>';
const middleRegistry = new Map();
const middleConversationKey = buildFromConversationKey(MAILBOX, FROM_B);
ok('register middle reference anchor', registerInboundThreadAnchor(
  middleRegistry,
  MAILBOX,
  middleMessageId,
  middleConversationKey,
));
const middleJoin = resolveInboundConversationKey({
  providerMailboxId: MAILBOX,
  fromAddress: FROM_A,
  references: `<root-thread@other.example> ${middleMessageId} ${newestMessageId}`,
  threadAnchorKeys: middleRegistry,
});
ok('References search newest→oldest picks registered middle anchor', Boolean(
  middleJoin
  && middleJoin.strategy === 'thread_join'
  && middleJoin.conversation_key === middleConversationKey
  && middleJoin.thread_anchor === middleMessageId.replace(/^<|>$/g, '').toLowerCase()
));

const unregisteredReply = resolveInboundConversationKey({
  providerMailboxId: MAILBOX,
  fromAddress: FROM_A,
  references: '<missing-root@mail.example> <missing-child@mail.example>',
  threadAnchorKeys: registry,
});
ok('unregistered References fall back to From-key', Boolean(
  unregisteredReply
  && unregisteredReply.strategy === 'from'
  && unregisteredReply.conversation_key === firstA.conversation_key
));

const crossMailboxRegistry = new Map();
ok('register same Message-ID on other mailbox', registerInboundThreadAnchor(
  crossMailboxRegistry,
  MAILBOX_OTHER,
  rootMessageId,
  buildFromConversationKey(MAILBOX_OTHER, FROM_B),
));
const mailboxScopedJoin = resolveInboundConversationKey({
  providerMailboxId: MAILBOX,
  fromAddress: FROM_A,
  inReplyTo: rootMessageId,
  threadAnchorKeys: crossMailboxRegistry,
});
ok('thread registry scoped by mailbox + Message-ID', Boolean(
  mailboxScopedJoin
  && mailboxScopedJoin.strategy === 'from'
  && mailboxScopedJoin.conversation_key === firstA.conversation_key
));

const unknown = matchSunsetGuestByInboundEmail('nobody@example.com', [
  { guest_id: GUEST_ID, email: 'elena.guest@example.com' },
]);
ok('unknown email → unmatched', unknown.status === 'unmatched');

const matched = matchSunsetGuestByInboundEmail(FROM_A, [
  { guest_id: GUEST_ID, email: 'elena.guest@example.com' },
  { guest_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: FROM_B },
]);
ok('known guest email → guest id', matched.status === 'matched' && matched.guest_id === GUEST_ID);

const idAlias = matchSunsetGuestByInboundEmail('elena.guest@example.com', [
  { id: GUEST_ID, email: 'ELENA.GUEST@EXAMPLE.COM' },
]);
ok('guest id alias via id field', idAlias.status === 'matched' && idAlias.guest_id === GUEST_ID);

const noFuzzy = matchSunsetGuestByInboundEmail('elena.guest@example.com', [
  { guest_id: GUEST_ID, email: 'elena@example.com' },
]);
ok('no fuzzy name/email match', noFuzzy.status === 'unmatched');

const duplicateDifferentIds = matchSunsetGuestByInboundEmail('elena.guest@example.com', [
  { guest_id: GUEST_ID, email: 'elena.guest@example.com' },
  { guest_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'ELENA.GUEST@EXAMPLE.COM' },
]);
ok('duplicate normalized guest email → unmatched', duplicateDifferentIds.status === 'unmatched');

const duplicateSameId = matchSunsetGuestByInboundEmail('elena.guest@example.com', [
  { guest_id: GUEST_ID, email: 'elena.guest@example.com' },
  { id: GUEST_ID, email: 'ELENA.GUEST@EXAMPLE.COM' },
]);
ok('duplicate normalized guest email with same guest id → unmatched', duplicateSameId.status === 'unmatched');

ok('from key helper matches resolver', Boolean(
  firstA
  && buildFromConversationKey(MAILBOX, FROM_A) === firstA.conversation_key
));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

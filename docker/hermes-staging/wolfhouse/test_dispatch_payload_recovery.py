"""Captain R3 regressions for exact pending-dispatch payload recovery."""
import importlib
import json
import subprocess
import unittest
from pathlib import Path

from hermes_state import SessionDB


test_accepted_quote = importlib.import_module('wolfhouse.test_accepted_quote')
ROOT = Path(__file__).resolve().parents[3]


class PendingDispatchPayloadRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.owner = test_accepted_quote.OwnerHostileTests()
        self.owner.setUp()

    def tearDown(self):
        self.owner.tearDown()

    @staticmethod
    def _timeout():
        raise TimeoutError('synthetic lost response')

    def _reopen_and_recover(self, message_id):
        owner = self.owner
        owner.db.close()
        owner.ledger._current.set(None)
        owner.db = SessionDB(Path(owner.temp.name) / 'state.db')
        owner.agent._session_db = owner.db
        owner.turn(message_id, 'Please finish that booking')
        return owner.ledger.prepare_create({})

    def _staff_recovery_status(self, first, recovered):
        script = r"""
const service = require('./scripts/lib/luna-front-desk-accommodation-booking-create-service.js');
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  const [firstBody, retryBody] = JSON.parse(input);
  const command = body => ({
    clientSlug: 'wolfhouse-somo',
    channel: service.BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    idempotencyKey: body.idempotency_key,
    transportBody: {...body, client_slug: 'wolfhouse-somo', phone: 'review-synthetic-identity'},
  });
  const firstCommand = command(firstBody);
  const retryCommand = command(retryBody);
  const fingerprint = service.wolfhouseOperationFingerprint(firstCommand);
  const pg = {query: async () => ({rows: [{
    booking_id: 'synthetic-saved-review', booking_code: 'REVIEW-ONLY',
    status: 'confirmed', metadata: {operation_fingerprint: fingerprint},
  }]})};
  const response = await service.executeWolfhouseBookingCreate(pg, retryCommand);
  process.stdout.write(JSON.stringify({status: response.status, body: response.body}));
});
"""
        result = subprocess.run(
            ['node', '-e', script], cwd=ROOT, input=json.dumps([first, recovered]),
            text=True, check=True, capture_output=True)
        return json.loads(result.stdout)

    def test_pending_dispatch_recovery_freezes_email_first_supplied_at_create(self):
        owner = self.owner
        owner.accept()
        prepared = owner.ledger.prepare_create({'email': 'review-only@example.invalid'})
        with self.assertRaisesRegex(TimeoutError, '^synthetic lost response$'):
            owner.ledger.dispatch_create(prepared, self._timeout)
        first = dict(prepared)
        recovered = self._reopen_and_recover('retry-after-reopen')
        self.assertEqual(dict(recovered), first)
        self.assertEqual(recovered['idempotency_key'], prepared['idempotency_key'])
        self.assertEqual(recovered['email'], 'review-only@example.invalid')
        self.assertEqual(self._staff_recovery_status(first, dict(recovered))['status'], 200)

    def test_pending_dispatch_recovery_keeps_email_from_shown_plan(self):
        owner = self.owner
        email = 'review-only@example.invalid'
        plan = {**owner.plan, 'email': email}
        owner.turn('email-offer', 'Quote this please')
        owner.present(plan, owner.checked(plan))
        owner.accept()
        prepared = owner.ledger.prepare_create({'email': email})
        with self.assertRaisesRegex(TimeoutError, '^synthetic lost response$'):
            owner.ledger.dispatch_create(prepared, self._timeout)
        first = dict(prepared)
        recovered = self._reopen_and_recover('shown-email-retry-after-reopen')
        self.assertEqual(dict(recovered), first)
        self.assertEqual(recovered['idempotency_key'], prepared['idempotency_key'])
        self.assertEqual(recovered['email'], email)
        self.assertEqual(self._staff_recovery_status(first, dict(recovered))['status'], 200)


if __name__ == '__main__':
    unittest.main()

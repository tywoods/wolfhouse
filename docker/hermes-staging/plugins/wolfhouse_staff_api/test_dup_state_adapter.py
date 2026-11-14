"""BC-K01 RED contract: supported question descriptors cross the real plugin adapter losslessly."""
from copy import deepcopy
import json
import os
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'docker/hermes-staging'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wolfhouse import accepted_quote as owner
import wolfhouse_staff_api as plugin


class DuplicateStateQuestionAdapterTests(unittest.TestCase):
    def test_supported_names_descriptor_survives_reopen_without_alias_filter_loss(self):
        descriptor = {
            'kind': 'names',
            'question_id': 'bc-k01-names-1',
            'guest_count': 2,
            'missing_guest_indices': [0, 1],
            'supported_names': [
                {'guest_index': 0, 'name': 'María José', 'aliases': ['Maria Jose', 'María']},
                {'guest_index': 1, 'name': 'Jean-Luc', 'aliases': ['Jean Luc', 'Jean']},
            ],
        }
        with patch.dict(os.environ, {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'}), \
             patch.object(owner, '_transaction', return_value=deepcopy(descriptor)), \
             patch.object(owner, '_staff_sent_reply_context', return_value={}), \
             patch.object(owner, 'shuttle_offer_context', return_value=None):
            first = plugin._pending_question_model_context()

        self.assertIsInstance(first, dict)
        self.assertEqual(first.get('pending_booking_question'), descriptor)
        prefix = 'Trusted booking workflow state: the last guest-facing question is '
        suffix = '. Use these facts and the conversation to understand the guest\'s reply.'
        serialized = first['context'].split(prefix, 1)[1].split(suffix, 1)[0]
        reopened = json.loads(serialized)
        self.assertEqual(reopened, descriptor)
        self.assertEqual(reopened['supported_names'][0]['aliases'], ['Maria Jose', 'María'])
        self.assertEqual(reopened['supported_names'][1]['aliases'], ['Jean Luc', 'Jean'])
        first['pending_booking_question']['supported_names'][0]['aliases'].append('mutated')
        self.assertEqual(reopened['supported_names'][0]['aliases'], ['Maria Jose', 'María'])
        self.assertEqual(descriptor['supported_names'][0]['aliases'], ['Maria Jose', 'María'])

    def test_question_context_read_failure_remains_diagnostic_and_never_becomes_save_denial(self):
        with patch.object(owner, '_transaction', side_effect=OSError('private details')):
            result = plugin._pending_question_model_context()
        self.assertIsInstance(result, dict)
        self.assertEqual(result['question_context']['status'], 'unavailable')
        self.assertEqual(result['question_context']['error'], 'question_authority_read_failed')
        self.assertTrue(result['question_context']['reconciliation_needed'])
        self.assertNotIn('private details', json.dumps(result))
        self.assertNotIn('write_performed', result)
        self.assertNotIn('booking_not_created_yet', result)


if __name__ == '__main__':
    unittest.main()

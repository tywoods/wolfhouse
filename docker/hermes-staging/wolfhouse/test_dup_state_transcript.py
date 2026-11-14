"""BC-S09/C10 qualification: real offline SQL + installed AQ/QR boundary.

Scripted model/author and stdio Staff transport; no network or guest delivery.
Reuse the P1 SQL observer without modifying its production services or tests.
"""
import hashlib
import json
import sqlite3
import unittest
from unittest.mock import patch
from hermes_state import SessionDB
from wolfhouse import accepted_quote as owner
from wolfhouse import test_save_before_payment_question_sql as sql_proof


class C10QualificationTests(unittest.TestCase):
    setUp = sql_proof.SaveBeforePaymentQuestionSQLTests.setUp
    rpc = sql_proof.SaveBeforePaymentQuestionSQLTests.rpc
    turn = sql_proof.SaveBeforePaymentQuestionSQLTests.turn
    clear_context = sql_proof.SaveBeforePaymentQuestionSQLTests.clear_context
    close_node = sql_proof.SaveBeforePaymentQuestionSQLTests.close_node
    deny_network = sql_proof.SaveBeforePaymentQuestionSQLTests.deny_network
    event = sql_proof.SaveBeforePaymentQuestionSQLTests.event
    http_edge = sql_proof.SaveBeforePaymentQuestionSQLTests.http_edge
    run_party = sql_proof.SaveBeforePaymentQuestionSQLTests.run_party

    def observe(self, name, receipt=None, text=None):
        sql_proof.SaveBeforePaymentQuestionSQLTests.observe(self, name, receipt=receipt, text=text)
        if name == 'TOOL_RECEIPT' and getattr(self, 'reject_transcript', False):
            self.db._conn.execute("CREATE TRIGGER reject_c10 BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'C10 transcript rejected'); END")
        if name == 'MODEL_QUESTION':
            self.before_drafts = self.db._conn.execute('SELECT count(*) FROM messages').fetchone()[0]
            for draft in ('Booking not saved. Pay now.', 'Draft: payment confirmed.'):
                self.agent._flush_messages_to_session_db([{'role': 'assistant', 'content': draft}])
            self.assertEqual(self.db._conn.execute('SELECT count(*) FROM messages').fetchone()[0], self.before_drafts)
        if name == 'FINAL_REPLY':
            self.returned_text = text

    def test_c10_rejected_flush_drafts_finalized_once_and_reopen(self):
        with patch.object(owner, 'finalize_offer_response', wraps=owner.finalize_offer_response) as finalize:
            self.run_party(2)
        # One quote turn and one saved-booking turn, each finalized once.
        self.assertEqual(finalize.call_count, 2)
        owner.close_turn()
        self.db.close()
        self.db = SessionDB(self.db_path)
        self.agent._session_db = self.db
        rows = self.db._conn.execute('SELECT id,role,content FROM messages ORDER BY id').fetchall()
        final = [r for r in rows if r['content'] == self.returned_text]
        self.assertEqual(len(final), 1)
        self.assertEqual(len(rows), self.before_drafts + 1)
        self.assertFalse(any('Draft:' in (r['content'] or '') or 'Booking not saved' in (r['content'] or '') for r in rows))
        states = [json.loads(r[0]) for r in self.db._conn.execute("SELECT value FROM state_meta WHERE key LIKE 'wolfhouse%'")]
        questions = [s['pending_question'] for s in states if s.get('pending_question', {}).get('status') == 'open']
        self.assertEqual(len(questions), 1)
        self.assertEqual(questions[0]['asked_message_id'], final[0]['id'])
        self.assertEqual(questions[0]['options'], ['deposit', 'full'])
        self.assertEqual(questions[0]['outbound_digest'],
                         hashlib.sha256(self.returned_text.encode()).hexdigest())
        self.assertEqual(self.db._conn.execute('SELECT message_count FROM sessions').fetchone()[0], len(rows))

    def test_c10_transcript_failure_keeps_real_sql_booking(self):
        self.reject_transcript = True
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'C10 transcript rejected'):
            self.run_party(1)
        saved = self.rpc(snapshot=True)
        self.assertEqual(len(saved['tables']['bookings']), 1)
        self.assertEqual(saved['tables']['bookings'][0]['id'], self.last_receipt['booking_id'])
        self.assertEqual(saved['tables']['bookings'][0]['status'], 'confirmed')
        self.assertEqual(self.db._conn.execute('SELECT count(*) FROM messages').fetchone()[0], self.before_drafts)
        self.assertEqual(self.link_attempts, [])
        self.assertEqual(self.network_attempts, [])


if __name__ == '__main__':
    unittest.main()

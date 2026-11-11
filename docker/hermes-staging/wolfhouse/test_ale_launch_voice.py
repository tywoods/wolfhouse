"""Item 14: synthetic STT transport; real patched ingress and quote-owner hook.

No audio/provider/Staff requests or guest sends. The test requires the production
patcher's transcription decorator; fixture code does not install that seam.
"""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from hermes_state import SessionDB
from wolfhouse import accepted_quote as owner
from wolfhouse.offline_ingress_harness import gateway_ingress


class _OwnerReached(Exception):
    pass


class AleLaunchVoiceTests(unittest.TestCase):
    def test_empty_voice_event_uses_raw_transcript_for_quote_turn(self):
        from agent import conversation_loop
        from gateway.config import Platform
        from run_agent import AIAgent

        transcript = 'Ciao, vorrei un preventivo per due persone.'
        plan = dict(check_in='2027-04-15', check_out='2027-04-22', guest_count=2)
        original_loop = conversation_loop.run_conversation
        with tempfile.TemporaryDirectory() as temp, patch.dict(
                'os.environ', {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'}):
            db = SessionDB(Path(temp) / 'state.db')
            db.create_session('voice-item14', source='whatsapp_cloud')
            agent = object.__new__(AIAgent)
            agent._session_db, agent.session_id = db, 'voice-item14'

            def model_boundary(_agent, message, *args, **kwargs):
                self.assertIn(transcript, message)
                try:
                    prepared = owner.prepare_quote(plan)
                except owner.QuoteBoundaryError as exc:
                    self.fail(str(exc))
                self.assertEqual(prepared['guest_count'], 2)
                observed = owner._transaction(lambda state, ingress: state['current_turn'])
                self.assertEqual(observed['raw'], transcript)
                self.assertEqual(observed['message_id'], 'voice-item14-message')
                raise _OwnerReached()

            try:
                owner.install_owner_hook()
                with patch('tools.transcription_tools.transcribe_audio', return_value={
                        'success': True, 'transcript': transcript}) as stt, patch.object(
                        conversation_loop, 'build_turn_context', side_effect=model_boundary):
                    with self.assertRaises(_OwnerReached):
                        gateway_ingress(agent, '', 'voice-item14-message',
                            lambda message: agent.run_conversation(message),
                            platform=Platform.WHATSAPP_CLOUD,
                            audio_paths=['/offline/item14-voice.ogg'])
                    stt.assert_called_once_with('/offline/item14-voice.ogg')
                self.assertIsNone(owner._current.get())
            finally:
                conversation_loop.run_conversation = original_loop
                owner.close_turn()
                db.close()


if __name__ == '__main__':
    unittest.main()

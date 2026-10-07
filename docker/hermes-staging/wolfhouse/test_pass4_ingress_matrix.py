"""Registered ingress handler negatives; response shim only, no HTTP listener."""
import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from wolfhouse import simulate_core as core
from wolfhouse import crowsnest_guest_door as door

class AdmissionMatrix(unittest.IsolatedAsyncioTestCase):
    async def test_ingress_matrix(self):
        routes = {}
        core.register_simulate_route(SimpleNamespace(router=SimpleNamespace(add_post=lambda p,f: routes.update({p:f}))))
        dispatch = AsyncMock(return_value={'ok':True})
        web = SimpleNamespace(json_response=lambda data,status=200:(status,data))
        cases = [
            ('missing', {}, {}, 401, None),
            ('wrong', {'X-Luna-Bot-Token':'wrong'}, {}, 401, None),
            ('malformed', {'X-Luna-Bot-Token':'offline'}, ValueError('bad json'), 400, None),
            ('list', {'X-Luna-Bot-Token':'offline'}, [], 400, None),
            ('namespace', {'X-Luna-Bot-Token':'offline'}, {'thread':'sim:golden-../bad','action':'cleanup'}, 400, None),
            ('staging', {'X-Luna-Bot-Token':'offline'}, {'thread':'sim:golden-test','text':'hello'}, 403, SystemExit('staging denied')),
            ('ordinary', {'Authorization':'Bearer offline'}, {'thread':'sim:ordinary','text':'hello','allow_writes':True}, 200, None),
            ('exception', {'X-Luna-Bot-Token':'offline'}, {'thread':'sim:ordinary','text':'hello'}, 500, None),
        ]
        with patch.dict(sys.modules, {'aiohttp':SimpleNamespace(web=web)}), patch.dict(os.environ, {'LUNA_BOT_INTERNAL_TOKEN':'offline'}), patch.object(core,'run_simulated_turn',dispatch):
            for name,headers,body,status,denial in cases:
                with self.subTest(name=name):
                    dispatch.reset_mock()
                    dispatch.side_effect = RuntimeError('dispatch failed') if name == 'exception' else None
                    async def request_json():
                        if isinstance(body,Exception): raise body
                        return body
                    with patch.object(core,'assert_staging_environment',side_effect=denial):
                        actual,_ = await routes[core.SIMULATE_PATH](SimpleNamespace(headers=headers,json=request_json))
                    self.assertEqual(actual,status)
                    if name in ('ordinary','exception'):
                        self.assertEqual(dispatch.call_count,1)
                        self.assertFalse(dispatch.call_args.kwargs['allow_writes'])
                    else: dispatch.assert_not_called()
        self.assertIsNone(door._SCOPE.get())
        self.assertIsNone(door._GOLDEN_REQUEST.get())

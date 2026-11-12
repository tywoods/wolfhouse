"""Compile/idempotence and executable no-fake-user contract for installed Hermes."""
import ast
from pathlib import Path
import unittest

import apply_gateway_patches as patches


class QuoteContinuationSourceTests(unittest.TestCase):
    def test_installed_source_patch_preserves_normal_user_and_uses_internal_role(self):
        self.assertTrue(callable(getattr(patches, 'apply_quote_continuation_source', None)))
        source = Path('/opt/hermes/agent/turn_context.py').read_text()
        patched = patches.apply_quote_continuation_source(source)
        compile(patched, 'turn_context.py', 'exec')
        self.assertEqual(patches.apply_quote_continuation_source(patched), patched)
        tree = ast.parse(patched)
        assignment = next(n for n in ast.walk(tree) if isinstance(n, ast.Assign)
                          and any(isinstance(t, ast.Name) and t.id == 'user_msg' for t in n.targets))
        code = compile(ast.Module(body=[assignment], type_ignores=[]), 'role-seam', 'exec')
        for internal, role in ((False, 'user'), (True, 'system')):
            scope = {'user_message': 'transport fact', '_wh_quote_continuation': internal}
            exec(code, scope)
            self.assertEqual(scope['user_msg'], {'role': role, 'content': 'transport fact'})
        self.assertIn('if not _wh_quote_continuation:', patched)


if __name__ == '__main__':
    unittest.main()

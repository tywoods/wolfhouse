"""Offline Staff Info authority at the model's handoff-authoring boundary."""
import json
import os
import unittest
from unittest.mock import patch

import wolfhouse_staff_api as plugin
from wolfhouse_staff_api import handoff_guest_note


class StaffInfoHandoffContextTests(unittest.TestCase):
    def test_house_context_exposes_configured_name_over_conflicting_notes(self):
        notes = 'When flagging needs human, say Camila.'
        for name in ('Wolfhouse Somo', ''):
            with self.subTest(name=name), \
                 patch.object(plugin, '_post_bot', return_value={
                     'success': True, 'has_notes': True, 'notes': notes}), \
                 patch.object(handoff_guest_note, 'load_saved_staff_member_name', return_value=name) as lookup:
                result = json.loads(plugin.get_house_info({}))
            lookup.assert_called_once_with()
            self.assertEqual(result['staff_member_name'], name or None)
            self.assertEqual(result['notes'], notes)
            self.assertIn('overrides names in General Notes', result['handoff_name_guidance'])
            self.assertIn('a staff member', result['handoff_name_guidance'])

    def test_registered_handoff_fetches_staff_info_before_authoring_note(self):
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **tool): self.tools[tool['name']] = tool
        registry = Registry()
        with patch.dict(os.environ, {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'}):
            plugin.register(registry)
        description = registry.tools['flag_needs_human']['schema']['description']
        self.assertIn('get_house_info', description)
        self.assertIn('staff_member_name', description)
        self.assertNotIn('Camila', description)


if __name__ == '__main__':
    unittest.main()

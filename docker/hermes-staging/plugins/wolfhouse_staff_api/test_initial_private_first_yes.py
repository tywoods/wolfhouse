"""Initial private request + payment instruction must not acquire a final yes gate.
These are instruction contracts, not a claim of live model acceptance.
"""
import os
from pathlib import Path
import unittest
from unittest.mock import patch
import wolfhouse_staff_api as plugin


class InitialPrivateFirstYesTests(unittest.TestCase):
    def test_room_guides_distinguish_initial_booking_instruction_from_changed_offer(self):
        root = Path(plugin.__file__).resolve().parents[2]
        for path in (root / 'SOUL.md', root / 'soul-guides/11-rooms.md'):
            with self.subTest(path=path.name):
                text = path.read_text()
                self.assertIn('initial double/private request', text)
                self.assertIn('explicit payment instruction', text)
                self.assertIn('create in the same turn', text)
                self.assertIn('previously displayed offer', text)
                self.assertNotIn('still re-quote and obtain approval of the new price before continuing', text)

    def test_tool_descriptions_do_not_reintroduce_unconditional_private_approval(self):
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **tool): self.tools[tool['name']] = tool
        registry = Registry()
        with patch.dict(os.environ, {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'}):
            plugin.register(registry)
        for name in ('quote_booking', 'create_booking_from_plan'):
            description = registry.tools[name]['schema']['description']
            self.assertIn('initial double/private request', description)
            self.assertIn('explicit payment instruction', description)
            self.assertIn('no final confirmation question', description)
        self.assertNotIn('ask whether the new price is OK', registry.tools['quote_booking']['schema']['description'])


if __name__ == '__main__':
    unittest.main()

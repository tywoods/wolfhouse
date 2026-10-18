from pathlib import Path
import unittest


class Sim19AccommodationRouteTests(unittest.TestCase):
    def test_accommodation_only_routes_directly_to_canonical_quote(self):
        soul = (Path(__file__).resolve().parents[1] / 'SOUL.md').read_text()
        self.assertIn('For accommodation-only requests, do not call `preview_package_prices`', soul)
        self.assertIn('route directly to `quote_booking`', soul)


if __name__ == '__main__':
    unittest.main()
import importlib.util
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / "install_simulator_route.py"


class InstallerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("install_simulator_route", MODULE)
        if spec is None or spec.loader is None:
            raise RuntimeError("unable to load installer")
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def test_installs_route_once_and_fails_if_anchor_moves(self):
        source = (
            "class Adapter:\n"
            "    def start(self):\n"
            "            self._app.router.add_get(\"/health\", self._handle_health)\n"
        )
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "api_server.py"
            target.write_text(source)
            self.module.install(target)
            self.module.install(target)
            installed = target.read_text()
            self.assertEqual(installed.count("register_simulator_route(self._app, self)"), 1)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "api_server.py"
            target.write_text("class Adapter:\n    pass\n")
            with self.assertRaisesRegex(RuntimeError, "anchor"):
                self.module.install(target)


if __name__ == "__main__":
    unittest.main()

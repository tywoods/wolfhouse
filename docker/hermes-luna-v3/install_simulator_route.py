#!/usr/bin/env python3
"""Install the Luna v3 simulator route into the pinned Hermes API adapter."""

from pathlib import Path
import importlib.util

_TAG = "_luna_v3_sim.register_simulator_route(self._app, self)"
_ANCHOR = '            self._app.router.add_get("/health", self._handle_health)\n'
_BLOCK = '''            import sys as _luna_v3_sys
            if "/etc/hermes-luna-v3" not in _luna_v3_sys.path:
                _luna_v3_sys.path.insert(0, "/etc/hermes-luna-v3")
            from runtime import simulator_route as _luna_v3_sim
            _luna_v3_sim.register_simulator_route(self._app, self)
'''


def install(path: Path) -> None:
    source = path.read_text()
    if _TAG not in source:
        if _ANCHOR not in source:
            raise RuntimeError("api server health route anchor not found")
        source = source.replace(_ANCHOR, _ANCHOR + _BLOCK, 1)
        path.write_text(source)
    compile(path.read_text(), str(path), "exec")
    if path.read_text().count(_TAG) != 1:
        raise RuntimeError("Luna v3 simulator route installation is not idempotent")


def main() -> None:
    try:
        spec = importlib.util.find_spec("gateway.platforms.api_server")
    except ModuleNotFoundError as exc:
        raise RuntimeError("api_server module not found") from exc
    if spec is None or not spec.origin:
        raise RuntimeError("api_server module not found")
    install(Path(spec.origin))


if __name__ == "__main__":
    main()

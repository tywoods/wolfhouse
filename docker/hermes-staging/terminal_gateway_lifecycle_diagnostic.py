"""Diagnostics for the resident in-gateway terminal classifier.

The recovered ``terminal_tool.py`` (SHA256
``01fde249886999f2ed7de936ac610221214572abf8d0baaff008670d59be7dc1``)
denies a command when ``_contains_terminal_gateway_lifecycle_command``
returns true, then always reports that denial as a gateway self-stop.
Descriptor duplication such as ``2>&1`` is one of those true results. It is
rejected while the redirect is scanned, before any lifecycle command is
confirmed.

This module keeps that same allow/deny split. It adds a reason:

- ``lifecycle`` — the parser confirmed hermes/systemctl/launchctl/kill forms
  the resident classifier already denies
- ``unsupported`` — the resident fail-closed paths (unparsed syntax, expansion,
  unknown wrappers, depth and length limits, and every other former ``True``
  that is not a confirmed lifecycle hit)
- ``allow`` — the resident classifier returned false

Nothing in ``allow`` is new. ``2>&1`` stays ``unsupported`` and is still
denied. ``force=True`` is not a parameter and cannot bypass either denial.

Applying this module to a checkout does not change the running gateway. The
recorded command remains denied until a later, separate grammar review says
otherwise. This module is not that review.
"""

from __future__ import annotations

import re
import shlex

LIFECYCLE_DENIAL_ERROR = (
    "Blocked: cannot restart or stop the gateway from inside the "
    "gateway process. The gateway would kill this command before "
    "it could complete (SIGTERM propagates to child processes). "
    "Run `hermes gateway restart` from a separate shell outside "
    "the running gateway."
)

UNSUPPORTED_DENIAL_ERROR = (
    "Blocked: unsupported shell syntax. The in-gateway terminal guard "
    "could not classify this command, so it was not executed. This is "
    "not a confirmed gateway lifecycle action. Descriptor duplication, "
    "heredocs, expansion, unknown wrappers, and other unscanned forms "
    "stay fail-closed."
)

_KINDS = frozenset({"allow", "lifecycle", "unsupported"})


def _looks_like_env_assignment(token: str) -> bool:
    """Return True when *token* is a leading shell environment assignment."""
    if "=" not in token or token.startswith("="):
        return False
    name, _value = token.split("=", 1)
    return bool(re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name))


def _read_shell_token(command: str, start: int, *, redirections: bool = False) -> tuple[str, int]:
    """Read one shell token, preserving quotes/escapes, starting at *start*."""
    i = start
    n = len(command)

    while i < n:
        ch = command[i]
        if ch.isspace() or ch in ";|&()" or (redirections and ch in "<>"):
            break
        if ch == "'":
            i += 1
            while i < n and command[i] != "'":
                i += 1
            if i < n:
                i += 1
            continue
        if ch == '"':
            i += 1
            while i < n:
                inner = command[i]
                if inner == "\\" and i + 1 < n:
                    i += 2
                    continue
                if inner == '"':
                    i += 1
                    break
                i += 1
            continue
        if ch == "\\" and i + 1 < n:
            i += 2
            continue
        i += 1

    return command[start:i], i


def _classify_terminal_gateway_lifecycle_command(command: str, _depth: int = 0) -> str:
    """Return ``allow``, ``lifecycle``, or ``unsupported``.

    Denial parity with the resident bool classifier: the result is ``allow``
    only where that function returned false. Both other results still refuse
    execution. Unsupported syntax is not relabeled as a lifecycle hit, and a
    confirmed lifecycle hit is not relabeled as syntax.
    """
    if _depth >= 12 or len(command) > 100_000:
        return "unsupported"

    def classify(words):
        while words and _looks_like_env_assignment(words[0]):
            words = words[1:]
        if not words:
            return "allow"
        name = words[0].rsplit("/", 1)[-1].lower()
        args = words[1:]
        if any(c in name for c in "*?["):
            return "unsupported"
        if name in {"timeout", "env", "sudo", "command", "exec", "nohup"}:
            flags = {
                "timeout": {"--foreground", "--preserve-status", "--verbose", "-v"},
                "env": {"-i", "--ignore-environment", "-0", "--null"},
                "sudo": {"-n", "-E", "-H", "--non-interactive", "--preserve-env"},
                "command": {"-p"}, "exec": {"-c", "-l"}, "nohup": set(),
            }[name]
            values = {
                "timeout": {"-s", "--signal", "-k", "--kill-after"},
                "env": {"-u", "--unset", "-C", "--chdir"},
                "sudo": {"-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt"},
                "command": set(), "exec": {"-a"}, "nohup": set(),
            }[name]
            while args and args[0].startswith("-"):
                option = args.pop(0)
                if option == "--":
                    break
                if name == "command" and option in {"-v", "-V"}:
                    return "allow"
                if option in flags:
                    continue
                if option in values:
                    if not args:
                        return "unsupported"
                    args.pop(0)
                    continue
                if any(option.startswith(v + "=") for v in values if v.startswith("--")):
                    continue
                if any(option.startswith(v) and len(option) > len(v)
                       for v in values if len(v) == 2):
                    continue
                return "unsupported"
            if name == "timeout":
                if not args or not re.fullmatch(r"(?:\d+(?:\.\d*)?|\.\d+)[smhd]?", args.pop(0)):
                    return "unsupported"
            return classify(args) if args else "unsupported"
        if name in {"sh", "bash", "dash", "zsh", "ksh"}:
            if not args or not re.fullmatch(r"-[elux]*c[elux]*", args[0]):
                return "unsupported"
            if len(args) < 2:
                return "unsupported"
            return _classify_terminal_gateway_lifecycle_command(args[1], _depth + 1)
        if name in {"stdbuf", "ionice", "xargs", "watch", "taskset", "chrt",
                    "numactl", "chroot", "unshare", "nsenter", "prlimit",
                    "setpriv", "runuser", "su", "doas", "flock", "setsid",
                    "systemd-run", "start-stop-daemon", "daemonize", "parallel"}:
            return "unsupported"
        if name in {"eval", ".", "source", "if", "then", "else", "elif", "fi",
                    "for", "while", "until", "do", "done", "case", "esac", "function",
                    "select", "coproc", "!", "time", "builtin", "nice"}:
            return "unsupported"
        lowered = [arg.lower() for arg in args]
        if name == "hermes":
            hit = any(lowered[i:i + 2] in (["gateway", "restart"],
                      ["gateway", "stop"], ["gateway", "start"])
                      for i in range(len(lowered)))
            return "lifecycle" if hit else "allow"
        if name in {"systemctl", "launchctl"}:
            actions = {"restart", "stop", "start"} if name == "systemctl" else {
                "kickstart", "unload", "load", "stop", "restart"}
            hit = bool(actions.intersection(lowered) and any("hermes" in a for a in lowered))
            return "lifecycle" if hit else "allow"
        if name in {"kill", "pkill"}:
            target = " ".join(lowered)
            hit = "hermes" in target and "gateway" in target
            return "lifecycle" if hit else "allow"
        return "allow"

    words = []
    i = 0
    redirect_target = False
    try:
        while i < len(command):
            ch = command[i]
            if ch.isspace():
                if ch == "\n":
                    if redirect_target:
                        return "unsupported"
                    decision = classify(words)
                    if decision != "allow":
                        return decision
                    words = []
                i += 1
                continue
            if ch == "#":
                if redirect_target:
                    return "unsupported"
                end = command.find("\n", i)
                i = len(command) if end < 0 else end
                continue
            if ch in ";|&(){}":
                if redirect_target:
                    return "unsupported"
                decision = classify(words)
                if decision != "allow":
                    return decision
                words = []
                i += 1
                continue
            redirect = re.match(r"[0-9]*(?:>>?|<)", command[i:])
            if redirect:
                if redirect_target:
                    return "unsupported"
                i += redirect.end()
                if i == len(command) or command[i] in "<>&|()":
                    return "unsupported"
                redirect_target = True
                continue
            raw, i = _read_shell_token(command, i, redirections=True)
            quote = None
            j = 0
            while j < len(raw):
                c = raw[j]
                if c == "\\" and quote != "'":
                    if raw[j:j + 2] == "\\\n":
                        return "unsupported"
                    j += 2
                    continue
                if c in "\"'" and (quote is None or quote == c):
                    quote = None if quote else c
                elif quote != "'" and c in "$`":
                    return "unsupported"
                elif quote is None and c in "<>{}":
                    return "unsupported"
                j += 1
            decoded = shlex.split(raw)
            if len(decoded) != 1:
                return "unsupported"
            if redirect_target:
                redirect_target = False
            else:
                words.append(decoded[0])
        if redirect_target:
            return "unsupported"
        return classify(words)
    except (ValueError, RecursionError):
        return "unsupported"


def _contains_terminal_gateway_lifecycle_command(command: str, _depth: int = 0) -> bool:
    """Resident denial bit. True for lifecycle hits and for fail-closed syntax."""
    return _classify_terminal_gateway_lifecycle_command(command, _depth) != "allow"


def terminal_gateway_guard_error(command: str) -> str | None:
    """Error string when the command must not run, else None.

    ``force`` is intentionally absent. Both denials stay in force.
    """
    kind = _classify_terminal_gateway_lifecycle_command(command)
    if kind not in _KINDS:
        return UNSUPPORTED_DENIAL_ERROR
    if kind == "allow":
        return None
    if kind == "lifecycle":
        return LIFECYCLE_DENIAL_ERROR
    return UNSUPPORTED_DENIAL_ERROR

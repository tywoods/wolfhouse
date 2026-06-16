#!/usr/bin/env python3
"""Verify Wolfhouse WhatsApp plain-reply patches inside a running Hermes container."""
import json
import sys

import gateway.platforms.base as ba
import gateway.platforms.whatsapp_cloud as wc
import gateway.run as gr
import gateway.stream_consumer as sc


def read(mod):
    return open(mod.__file__, encoding="utf-8").read()


checks = {
    "wa_send_clears_reply_to": "if not _wh_allow_quote" in read(wc),
    "wa_chunk_gated": "wolfhouse_quote_reply" in read(wc),
    "stream_adapter_aware": "_wolfhouse_stream_reply_anchor" in read(sc)
    and "self.adapter)" in read(sc),
    "run_whatsapp_initial_reply_none": "initial_reply_to_id=(" in read(gr)
    and "whatsapp_cloud" in read(gr),
    "run_runtime_hook": "install_runtime_whatsapp_patches" in read(gr),
    "base_reply_anchor_none": "whatsapp_cloud" in read(ba),
}
print(json.dumps(checks, indent=2))
if all(checks.values()):
    print("ALL OK")
    raise SystemExit(0)
print("MISSING PATCHES")
for key, ok in checks.items():
    if not ok:
        print("FAIL:", key)
raise SystemExit(1)

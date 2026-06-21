#!/usr/bin/env python3
"""Hotfix: restore scheduleUpdateDrawerPaymentFromContext in staff-query-api.js"""
from pathlib import Path

API = Path("/opt/wolfhouse/WH/scripts/staff-query-api.js")
api = API.read_text(encoding="utf-8")

BAD = """function scheduleWireEditableDrawer(row, ctx){
  if (!ctx || !ctx.payment) return;
  var pay = ctx.payment;
  var box = el('ps-drawer-payment-box');
  if (!box) return;
  var tmp = document.createElement('div');
  tmp.innerHTML = scheduleRenderDrawerPaymentSectionHtml(ctx);
  var fresh = tmp.firstChild;
  if (fresh) box.parentNode.replaceChild(fresh, box);
  scheduleWireDrawerStripeCopyOpen(ctx);
}

function scheduleWireDrawerStripeCopyOpen(ctx){"""

GOOD = """function scheduleUpdateDrawerPaymentFromContext(ctx){
  if (!ctx || !ctx.payment) return;
  var box = el('ps-drawer-payment-box');
  if (!box) return;
  var tmp = document.createElement('div');
  tmp.innerHTML = scheduleRenderDrawerPaymentSectionHtml(ctx);
  var fresh = tmp.firstChild;
  if (fresh) box.parentNode.replaceChild(fresh, box);
  scheduleWireDrawerStripeCopyOpen(ctx);
}

function scheduleWireDrawerStripeCopyOpen(ctx){"""

if BAD not in api:
    raise SystemExit("BAD block not found")
api = api.replace(BAD, GOOD, 1)
if "function scheduleUpdateDrawerPaymentFromContext" not in api:
    raise SystemExit("fix failed")
API.write_text(api, encoding="utf-8")
print("HOTFIX OK")

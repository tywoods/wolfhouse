# CAP PR1426 — ruling on empty original bodies and fault evidence

## Decision

An empty HTTP entity body **is not missing capture**. Under requirement #6, an already-invalid original may count. The actual plugin can observe HTTP 200 with zero body bytes, retain `original_response_hex: ""` and `raw_response_hex: ""`, then deliberately inject a timeout. That is a coherent transport failure. The same applies to malformed JSON, null, arrays and scalar originals. None licenses a quote, booking or payment assertion.

Missing capture keys, mismatched original/effective bytes for a timeout, missing event/session binding, forged success, and unsupported booked/paid result fields remain rejected. The legacy test incorrectly labelled two present empty byte strings as deletion. It now tests actual key removal and inconsistent byte replacement. A separate actual-plugin regression covers empty/invalid originals at HTTP 200, 422 and 500, preserving negative controls.

## Proof

Run `python3 -B scripts/test-luna-v3-grader-empty-body.py` with the Hermes Python dependencies available. It invokes the real plugin with a clearly labelled offline transport fixture and socket connections forbidden; no live owner/model claim is made. Receipt: `artifacts/cap-grader-continue/empty-body-green.stderr`.

## Authenticity boundary

A pure consumer proves coherence of supplied bytes and the plugin projection. It cannot distinguish an authentic empty response from a coherently substituted empty response without independent custody/authentication of the original capture. The live matrix retains request context and seals captured evidence. Coherent substitutions in previously sealed artifacts are an integrity failure of that artifact, not proof that zero-length HTTP responses are impossible. Historical probes and their expected results remain preserved; any disagreement must be reported, not silently relabelled.

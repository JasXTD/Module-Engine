# Verification output

```text
✔ pairing reads exactly one inert file, rotates tokens, suppresses unchanged bytes, and revokes on stop (75.5428ms)
✔ web origins, missing origins, rebinding hosts, paths, methods and unauthenticated reads are refused (54.6683ms)
✔ concurrent pairing claims have one winner and a fixed session expiry (15.9439ms)
✔ unclaimed pairing expires without extending itself (9.8543ms)
✔ atomic saves are tracked; missing, oversized and non-UTF8 files recover without leaking paths (30.7481ms)
✔ only local regular .user.js files are accepted; junction replacement cannot redirect reads (19.5553ms)
✔ slow partial requests have a fixed deadline and do not prevent a later approved read (5046.162ms)
✔ the real CLI selects an owned file and accepts its one-use terminal code without package installation (334.3975ms)
✔ metadata completion replaces only the current key or enum token (2.8047ms)
✔ completion is bounded to actual metadata and collapsed selections (0.7919ms)
✔ every suggested grant is supported; informational and flag keys are available (0.7424ms)
✔ external codes cannot select arbitrary hosts, paths, schemes or MCP ports via a URL (0.8699ms)
✔ Windows CRLF metadata parses identically and diagnostics retain raw-source offsets (15.3742ms)
✔ lint returns precise locations and treats source as inert text (3.9471ms)
✔ lint checks strict wrapper bindings and permits valid function-body syntax (9.1623ms)
✔ lint bounds oversized source and token output, and reports metadata separately (91.3879ms)
ℹ tests 16
ℹ suites 0
ℹ pass 16
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5809.269
```

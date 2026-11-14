# Verification output

```text
✖ Windows CRLF metadata parses identically and diagnostics retain raw-source offsets (2.0528ms)
✔ lint returns precise locations and treats source as inert text (10.3937ms)
✔ lint checks strict wrapper bindings and permits valid function-body syntax (7.7641ms)
✔ lint bounds oversized source and token output, and reports metadata separately (66.1443ms)
ℹ tests 4
ℹ suites 0
ℹ pass 3
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 288.6289

✖ failing tests:

test at tests\userscripts-editor.test.cjs:5:1
✖ Windows CRLF metadata parses identically and diagnostics retain raw-source offsets (2.0528ms)
  Error: Metadata lines must use // @key value.
      at fail (C:\Users\Tommy\Desktop\BlockAds\userscripts-core.js:18:35)
      at Object.parse (C:\Users\Tommy\Desktop\BlockAds\userscripts-core.js:33:19)
      at TestContext.<anonymous> (C:\Users\Tommy\Desktop\BlockAds\tests\userscripts-editor.test.cjs:7:43)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.start (node:internal/test_runner/test:1262:17)
      at startSubtestAfterBootstrap (node:internal/test_runner/harness:387:17)
```

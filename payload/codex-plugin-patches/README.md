# Codex plugin patches (1.0.3 and 1.0.6)

`scripts/lib/broker-lifecycle.mjs` fixes broker orphaning after failed or slow startup.
It retires abandoned brokers and coordinates startup and shutdown ownership.

`scripts/app-server-broker.mjs` unsubscribes a client's threads on disconnect to prevent thread leaks.
`scripts/lib/app-server.mjs` sets `thread_unload_delay_secs=0` so unsubscribed threads unload immediately.

`scripts/lib/app-server.mjs` also selects the unelevated Windows sandbox.
The elevated setup helper in npm Codex 0.162.x fails with "setup refresh had errors".

The manifest lists known versions in `versions` and one or more `variants` per target `rel`.
Each variant records `versions`, `orig`, `origSha256`, `patched` and `patchedSha256`.
Hashes in the manifest cover exact stored bytes; matching installed files normalises CRLF to LF.
Version labels are documentation: later versions with known file content are covered automatically.

The 1.0.3 files remain in `orig/` and `patched/`. Only `lib/app-server.mjs` and `lib/process.mjs`
need separate 1.0.6 copies under `1.0.6/orig/` and `1.0.6/patched/`. The broker and lifecycle files
share one variant listing both versions. The 1.0.6 variants retain upstream's `requestAttestation: false`,
stderr in the app-server exit error, and `options.shell ??` selection.

Cache roots ending in `/*` expand to every direct version directory, sorted by name. The marketplace
root is checked too. Unknown hashes are never patched. Silent SessionStart repair logs each unknown
target/hash once in `luna-run/plugin-patch-state.json`; `--check` reports statuses without writing.
Patching preserves the target's EOL, creates `*.orig-luna-harness` with `COPYFILE_EXCL`, and writes atomically.

- `scripts/lib/process.mjs`: `taskkill` exits 128 when the process is already gone. The plugin only recognised the
  English "not found" text, so on a Russian (or any non-English) Windows a dead job stayed `running` forever and the
  stop gate kept asking to cancel it. Patched to treat exit 128 as "already gone".

## Adding the next version

1. Copy pristine plugin originals byte-for-byte into `<version>/orig/scripts/...`; originals use the
   plugin's CRLF bytes. Never derive originals from an already patched install.
2. Make temporary LF-normalised copies of the previous original, previous patched file and new original.
   Run `git merge-file <new-original-LF> <previous-original-LF> <previous-patched-LF>` to apply the
   existing fixes to the new upstream content. Review conflicts and verify both fixes and upstream changes.
3. Save the merged result with LF only under `<version>/patched/scripts/...`. If an original and its
   patched content already match a known variant after normalisation, widen that variant's `versions`
   instead of duplicating its files. Keep the existing 1.0.3 paths.
4. Add a variant for each differing file and update top-level `versions`. Compute `origSha256` and
   `patchedSha256` with Node's `createHash('sha256').update(fs.readFileSync(file)).digest('hex')`
   over exact bytes. Conflicting originals and patched-to-original chains are rejected by the loader.
5. Add the new copies to `payload/manifest.json` with `kind: "file"` and destinations under
   `luna-harness/codex-plugin-patches/`. Recompute SHA256 for every changed payload file, including
   this README and the patch manifest. Run the plugin-patch and installer self-tests, followed by
   `node tests/verify-temp-home.mjs`. Remove temporary merge inputs afterwards.

The loader also accepts the old single-variant format with `orig` and `patched` directly on each file.

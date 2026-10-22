# Codex plugin patches (1.0.3)

`scripts/lib/broker-lifecycle.mjs` fixes broker orphaning after failed or slow startup.
It retires abandoned brokers and coordinates startup and shutdown ownership.

`scripts/app-server-broker.mjs` unsubscribes a client's threads on disconnect to prevent thread leaks.
`scripts/lib/app-server.mjs` sets `thread_unload_delay_secs=0` so unsubscribed threads unload immediately.

`scripts/lib/app-server.mjs` also selects the unelevated Windows sandbox.
The elevated setup helper in npm Codex 0.162.x fails with "setup refresh had errors".

The patched files were verified byte-identical between the source cache and marketplace copies.
The manifest records both original and patched SHA256 hashes for both installation roots.

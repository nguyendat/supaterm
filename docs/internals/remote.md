# Remote architecture

Each connection joins a client to one environment over HTTP and WebSocket. The
environment owns providers, execution, files, and durable state. Direct access,
Tailscale, and SSH change how the client reaches that server; they do not
introduce another execution model. See
[remote access](../user/remote-access.md) for setup.

## Identity is independent of the route

An environment keeps its ID across server restarts and endpoint changes. Saved
connections are local to a client profile; the server's identity and state are
not. A repository identity can correlate clones across environments, but never
routes work between them. A project and its threads belong to one environment.
The canonical key follows the `upstream` remote when one exists, so pull request
features target the repository a fork tracks. A fork also reports its own
`origin`, and clients group and label by that, so a fork never collapses into a
checkout of its upstream.

[Environment ID initialization](../../apps/server/src/environment/ServerEnvironment.ts)
must publish a complete ID atomically. Repair of an empty ID file retains a
recovery file so concurrent or delayed initializers choose the same winner.
Removing that recovery state as ordinary temporary-file cleanup can change the
identity underneath an already-running server.

Advertised endpoints are reachability hints. Only the connecting device can
prove that a route works. In particular, a host's loopback address refers to a
different machine when another device opens it. Endpoint selection must not
silently fall back to loopback when a shareable endpoint is unavailable.

Saved routes share one environment identity but may have separate credentials.
The [driver](../../packages/client-runtime/src/connection/driver.ts) verifies a
direct address against the public environment descriptor before sending its
credential. A saved LAN address may belong to a different machine after a network
change. The [supervisor](../../packages/client-runtime/src/connection/supervisor.ts)
authorizes a preferred route before replacing a working session and applies a
cooldown after a failed switch.

Learned routes reuse their saved pairing's bearer credential. Removing that
pairing removes its learned routes; an updated advertisement removes addresses
the server no longer reports. User-saved routes survive advertisement changes.

[GitHub routing trust](../../packages/client-runtime/src/connection/githubRoutingPermissions.ts)
covers every user-saved route. Adding or changing an address revokes the grant;
reordering and learned-address changes preserve it.

## Hosted web is a client

The hosted web app stores its connection catalog in the browser and connects
directly to each environment. It does not proxy traffic or hold server-side
pairing state. Hosting the UI over HTTPS therefore cannot make a plain HTTP LAN
backend accessible from that browser context.

A [hosted pairing URL](../../apps/web/src/hostedPairing.ts) identifies the backend
in its query and carries the pairing secret in its fragment. Fragments stay out
of requests to the hosted origin. The browser exchanges the secret with the
environment and strips it from its history. Moving the token into a query
parameter would disclose it to the wrong origin.

## Access and process ownership are different

Tailscale supplies an endpoint for ordinary pairing, so it needs no separate
environment type. Authentication remains the environment's responsibility for
every route. See [environment authentication](./environment-auth.md).

SSH can launch a server as well as forward a port. Desktop main owns that
lifecycle because it can spawn SSH and handle authentication prompts. The
renderer uses the forwarded endpoint through the shared connection runtime.
[SSH cleanup](../../packages/ssh/src/tunnel.ts) stops a remote server only if the
launcher owns it; a server it discovered already running must survive a client
disconnect. Reconnection restores the forward before opening the application
transport.

Remote servers can outlive several client releases. Clients must use advertised
capabilities and handle their absence, rather than assume their own version
describes the server. Process replacement belongs to the launcher's
[update protocol](./server-updates.md); the connection runtime handles the
resulting disconnect.

### Desktop without a local environment

Desktop normally launches its own primary server, but the desktop setting `localEnvironmentEnabled`
(`apps/desktop/src/settings/DesktopAppSettings.ts`) turns that off. Changing it relaunches the app;
no local state is deleted. On the next start the main process skips port selection, server exposure,
and the primary and WSL backends, and opens the window right away. The renderer sees this through
`desktopBridge.getLocalEnvironmentEnabled()`: `readPrimaryEnvironmentTarget` returns null, so primary
auth and platform-managed discovery are skipped and only saved environments (pairing, SSH) connect.
This is possible because the desktop renderer is not served by the backend: the `supaterm://` scheme
serves the bundled client from disk (Vite in development) and API traffic always goes to the
environment's own URL.

## Push stays outside the relay tunnel

An iOS tunnel is suspended in the background. Push therefore uses a separate
APNs gateway, executable, database, and HTTPS origin. The live relay does not
store push recipients or carry notification traffic.

The host commits notification intents and per-device delivery rows with the
orchestration event and projection. Its delivery worker runs in a separate lane
so a gateway outage cannot block provider effects. Retries stop at expiry, and
restart recovery uses durable leases. The gateway owns APNs credentials, token
routing, immediate revocation, and bounded delivery receipts. It has no content
queue: unsent work waits for the host to return.

Enrollment binds a host-signed request to an APNs possession challenge. The
challenge travels only through APNs and returns through the authenticated host
session before delivery becomes eligible. Registrations belong to that session;
revoking the session stops host delivery. Re-pairing transfers the existing
recipient only with proof of the device's stored revocation secret, and advances
its generation to fence delayed requests from the previous session. Device
revocation also reaches the gateway directly, while local intent is reconciled
with the host on reconnect.

Alerts carry opaque identifiers and a fixed generic fallback. Optional previews
use a separate per-environment, per-device X25519 key held in shared Keychain
access for the app and Notification Service Extension. The host encrypts with
RFC 9180 HPKE using HKDF-SHA256 and ChaCha20-Poly1305, then signs the envelope
with its durable push identity. The extension trusts that signing key only after
receiving it through the authenticated host connection. Recipient, registration
generation, key epoch, notification ID and expiry are authenticated together.
Relay tunnel keys never participate in notification encryption.

The host persists each device's opaque payload before attempting delivery, so
retries retain the same ciphertext and gateway receipt identity. The extension
checks the active device binding and a bounded replay ledger before showing a
preview. Keys are unavailable after reboot until first unlock; missing keys,
invalid envelopes, expiry and extension failures retain the generic alert.

APNs and the gateway see delivery metadata, but no preview plaintext. A
notification is a hint: the app resolves it against the host and waits for
authoritative state before navigating.

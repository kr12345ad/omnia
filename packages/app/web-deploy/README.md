# Omnia web at omnia.openfoodpantry.org

The web build is the same app, cut down: no computer control, superskills,
memory, chat channels, or server management. Browser automation stays.
Logins are the same control-plane GitHub and Google flows the desktop uses.

## Build

From the repo root:

```sh
cd packages/app && npm exec --yes bun -- run build
cd ../opencode && npm exec --yes bun -- run script/build.ts linux-x64
```

The second step embeds the app UI in the server binary. It runs the app
build itself, so step one is only for checking the bundle early.

## Run

```sh
OPENCODE_SERVER_PASSWORD=<a-strong-password> ./dist/opencode-linux-x64/bin/opencode serve --hostname 127.0.0.1 --port 4096
```

The control plane runs separately (packages/omnia, `omnia-server`), bound
to 127.0.0.1:4312. The web sign-in code calls it at /test1/omnia on the
same origin.

## Reverse proxy

Put Caddy (or any reverse proxy) in front. The included Caddyfile routes
everything to the server binary and /test1/omnia/* to the control plane.
The app's server URL injects itself from the host, so browsers use the
same origin throughout.

## Notes

- The login rate limiter returns 429 for a few minutes after several auth
  starts. That is the control plane, not the app.
- The embedded UI build serves index.html and chat.html. The full app is
  served; do not set OPENCODE_CHAT_ONLY, which would hide the browser panel
  and the workspace.
- The web settings tab hides computer, superskills, memory, chat channels,
  and servers. The browser panel matches desktop when a desktop browser
  runtime is reachable; the agent browser tool is always available.

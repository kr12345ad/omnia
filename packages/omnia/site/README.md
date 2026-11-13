# Omnia site

The single-file marketing page for Omnia. It is also the collateral sent to
TryGravity with the publisher application: it shows the product, the free
tier, and the exact sponsored-card placement being applied for.

Everything is inline: no fonts, scripts, images or build step. `index.html`
can be opened directly, dropped on any static host, or zipped and sent.

## Preview

```sh
bun packages/omnia/site/serve.ts
# http://localhost:4173
```

`PORT=8080 bun packages/omnia/site/serve.ts` changes the port.

## Live deployment

Served at <https://omnia.openfoodpantry.org> by a dedicated Cloudflare Tunnel
connector (`omnia-site`) pointing at `127.0.0.1:4174`.

- Origin: `serve.ts` (loopback only, index.html only, security headers).
- Tunnel config: `~/.cloudflared/omnia-site.yml`.
- Services: `omnia-site.service` and `omnia-site-tunnel.service` (user units,
enabled; linger is on so they survive logout and reboot).
- Status/logs: `systemctl --user status omnia-site omnia-site-tunnel`.
- Restart: `systemctl --user restart omnia-site omnia-site-tunnel`.

This is a separate tunnel from the `openfoodpantry` connector; the main site
and `/test1` control plane are untouched.

## Deploy

The folder is the artifact; there is no build command.

- **Cloudflare Pages / Netlify / Vercel:** publish directory
  `packages/omnia/site`, no build step.
- **Any static server:** point the document root at `packages/omnia/site`.
- **Zip for an application form:**

  ```sh
  (cd packages/omnia/site && zip -r ../omnia-site.zip index.html)
  ```

If it is served at `https://omnia.openfoodpantry.org/`, the absolute URLs in
the page (`og:url`, download and docs links) already match the control plane
host. Replace the contact and `Advertise` mailto links if a different address
should receive publisher mail.

## What is on the page

1. Hero with a real session mock and a labelled `Sponsored` card.
2. Product features: real apps, verification, approvals, local data,
   bring-your-own model, human takeover.
3. Three interactive runs (invoices, browser login, approval) with replay.
4. Security and permission model.
5. **Free & ads** — the card format, placement rules and a plain-language
   privacy disclosure.
6. Pricing (Free $0 / Pro $15 / Business $49).
7. FAQ and download CTA.

## Before sending to TryGravity

- Keep the sample card labelled `Sponsored`; it is the placement under review.
- The disclosure must stay accurate: on Free, only the latest request text and
  a session id leave the machine for ad matching. If that changes, update the
  copy before publishing.
- The page intentionally has no tracking scripts or third-party requests.

# Omnia

Omnia is a local-first computer agent with a desktop app, a self-hostable server, and an open protocol. It can drive your computer, run code, connect to chat channels and remote machines, and keep working from a local session.

Omnia is open source under the MIT license. The client and the server are free to use, study, modify, and self-host. An Omnia account is optional: the public build runs locally without one. Sign-in is only needed for hosted services such as cloud vision, hosted relay, and team administration.

## Install

Download the latest build from https://omnia.openfoodpantry.org/downloads.html

- Linux: AppImage, deb, rpm
- macOS: arm64 and x64 zips
- Windows: x64 installer

The desktop app creates a local server on first launch. You can use it without signing in.

## Self-host

The Omnia server lives in `packages/omnia`. It is free to run and free to adapt. See `packages/omnia/README.md` for the server entry points and environment variables.

## Plans

Open source does not remove the cost of running a hosted service. The boundary is:

- Free and self-hosted: the full local client, local computer control, self-hosted server, and local customization.
- Pro: hosted relay, hosted compute, cloud vision, and managed convenience.
- Team: SSO, SCIM, RBAC, audit export, shared administration.
- Enterprise: self-host licensing, support, SLA, and managed deployment.

The plan matrix lives in `packages/omnia/src/billing/plans.ts`.

## Account sunset

The public Omnia login remains available until January 17, 2027. After that date, local use and self-hosting continue to work without an account. Hosted accounts need a migration path before the sunset. The date is a service commitment, not a license term.

## Development

Requirements: Bun 1.3+ and Node 22+.

```bash
bun install
bun dev
```

Desktop development:

```bash
cd packages/desktop
bun run dev
```

Never run the test suite from the repository root; run it from the package that owns the tests.

## Contributing

See `CONTRIBUTING.md` and `AGENTS.md`. Security reports go through GitHub security advisories; see `SECURITY.md`.

## License

MIT. See `LICENSE`.

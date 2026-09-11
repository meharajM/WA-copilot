# Release Readiness

This document defines the production release boundary for AIConsumerAgent.

Customer connection onboarding is documented in
`docs/customer-connection-onboarding.md`; the production OAuth connection
service and HTTPS webhook relay remain deployment work.

## Deterministic Gate

Run:

```bash
npm run release:gate
```

The gate requires:

- a clean Git worktree,
- matching `package.json` and `package-lock.json` versions,
- a version newer than the previously published `1.0.0` artifacts,
- clean diff whitespace,
- lint and both TypeScript checks,
- unit and integration suites,
- the Electron Playwright smoke suite,
- a successful production bundle.

Production publish scripts do not support `--skip-checks`. `--skip-build` may reuse artifacts, but all release and artifact-verification gates still run.

For an isolated local macOS package check, run `npm run test:e2e:packaged:mac`. It creates an Apple Development-signed QA bundle under `dist/qa-mac`; it is not a public release artifact.

## macOS Distribution

Required before upload:

- Apple Developer Program membership,
- a `Developer ID Application` certificate,
- Apple notarization credentials,
- hardened runtime and the tracked entitlement files under `build/`,
- successful `codesign`, Gatekeeper, and stapler validation for the app,
- successful DMG and stapler validation.

`scripts/verify-macos-release.sh` enforces these requirements. The installer verifies the installed app and never removes quarantine attributes.

## Windows Distribution

Set `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` for the public certificate. Production Windows builds use electron-builder's `forceCodeSigning` option and fail if signing credentials are unavailable.

## External QA Gate

Before publishing a candidate, record evidence for:

1. A dedicated test mailbox connection.
2. One inbound message becoming an email session.
3. Draft-first handling with no duplicate send.
4. One approved reply arriving in the original thread.
5. A sensitive-topic message remaining escalated.
6. A low-confidence non-sensitive message receiving one acknowledgement and creating an owner review draft.

Keep Draft Mode on until these checks pass. Live OpenRouter tests are a separate provider/account gate because they require valid external credentials.

## Artifact Integrity

Publishing writes and uploads `SHA256SUMS` for each platform output directory. Versioned artifacts must be built from the committed release candidate; do not overwrite an existing version.

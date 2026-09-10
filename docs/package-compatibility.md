# Package and packaged-Electron compatibility

Date: September 9, 2026

The repository now has a fail-closed local check:

```sh
npm run check:runtime
```

It verifies the declared Node engine, the installed Electron executable, and a
machine-readable license field for every direct dependency. It prints the
resolved versions and license inventory so release review is based on the
lockfile/install actually used.

Current evidence on the development host:

- The application declares Node `>=22.12.0`.
- Node `22.22.2` passes the declared engine check when the supported Node
  runtime is selected.
- Electron resolves to `40.10.6` within the declared Electron 40 range, and its platform executable is present after
  the Electron postinstall payload is restored.
- Native modules include `better-sqlite3` and libsignal. Their Electron ABI
  rebuild completed during an unsigned macOS arm64 Electron 40 directory
  build. The packaged executable launched far enough to initialize the main
  process and registered its Memory, Store and Secure storage handlers.
- The development host's normal Apple signing identity stalled during the
  first package attempt; the verification build therefore used ad-hoc signing.
  Production signing/notarization remains a release-host gate.
- `@whiskeysockets/libsignal-node` reports `GPL-3.0`; distribution licensing
  review is required before shipping a production bundle. This is an explicit
  legal gate, not an automated approval.
- The production dependency audit was rerun after applying available
  non-breaking lockfile updates. Findings dropped from 27 to 6. The remaining
  findings are an Electron patched-version/major-upgrade decision, an unfixed
  libsignal `protobufjs` advisory, and an unfixed `vosk-browser` `uuid`
  advisory. `npm audit fix --force` was not used because it changes the Electron
  major version.

The checklist item remains open until dependency-license review, production
signing/notarization and a clean release-host package run are recorded. The
Node 22 runtime check, Electron 40 native rebuild and local packaged launch
have now been verified. The remaining audit findings are release blockers to
resolve or explicitly accept in the distribution/security review.

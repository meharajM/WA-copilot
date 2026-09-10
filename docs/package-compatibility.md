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
- Node `22.12.0` passes the declared engine check when the supported Node
  runtime is selected.
- Electron resolves to `44.3.0` within the declared Electron 44 range, and its platform executable is present after
  the Electron postinstall payload is restored.
- Native modules include `better-sqlite3` and libsignal. `better-sqlite3` was
  rebuilt for Electron 44 ABI `149` and loaded successfully from the Electron
  runtime; the application build and main/renderer typechecks also pass. The
  unsigned macOS arm64 directory package completed and its packaged main
  process stayed alive during an 8-second launch smoke test. The production
  signing identity remains a release-host gate.
- `electron-builder` 26.4.0 bundled an older `node-abi` that could not resolve
  Electron 44. The direct dev dependency `node-abi@4.35.0` keeps the builder
  able to rebuild native modules for the selected Electron version.
- Packaging mutates the workspace native module to Electron ABI `149`; local
  Node/Vitest checks require `npm rebuild better-sqlite3` afterward to restore
  Node ABI `127`. Release CI should package from a clean install or perform
  the equivalent rebuild in its next job.
- The development host's normal Apple signing identity stalled during the
  first package attempt; the verification build therefore used ad-hoc signing.
  Production signing/notarization remains a release-host gate.
- `@whiskeysockets/libsignal-node` reports `GPL-3.0`; distribution licensing
  review is required before shipping a production bundle. This is an explicit
  legal gate, not an automated approval.
- The production dependency audit was rerun after the Electron 44 upgrade.
  Findings dropped from 6 to 5: Baileys, libsignal, `protobufjs`, `uuid` and
  `vosk-browser`. The remaining findings are upstream/unfixed in the current
  dependency graph; `npm audit fix --force` was not used.
- Latest `npm audit --omit=dev --json` baseline: 5 findings total (2 moderate,
  2 high, 1 critical), affecting the same five packages listed above. The
  machine-readable audit was run on September 10, 2026; release review must
  decide whether to remediate, isolate, or explicitly accept each finding.

Latest local verification (`npm run check:runtime`, September 10, 2026):
Node `22.12.0`, Electron `44.3.0`, Electron executable present, and every
direct dependency reported a machine-readable license. This confirms runtime
compatibility evidence only; it does not approve GPL distribution, upstream
advisories, production signing/notarization, or a clean release-host package.

The checklist item remains open until dependency-license review, production
signing/notarization and a clean release-host package run are recorded. The
Node 22 runtime check, Electron 44 native rebuild and application build have
now been verified. The remaining audit findings are release blockers to
resolve or explicitly accept in the distribution/security review.

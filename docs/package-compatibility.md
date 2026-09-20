# Package and packaged-Electron compatibility

Date: September 11, 2026

The repository now has a fail-closed local check:

```sh
npm run check:runtime
```

It verifies the declared Node engine, the installed Electron executable, loads
each required native module and executes a minimal SQLite query, and checks a
machine-readable license field for every direct dependency. It prints the
resolved versions, native-module ABI and license inventory so release review is
based on the lockfile/install actually used.

Current evidence on the development host:

- The application declares Node `>=22.12.0`.
- The current host is Node `20.20.2` (Node ABI `115`), so the declared engine
  check correctly fails until the supported Node runtime is selected.
- `better-sqlite3` loads and executes `SELECT 1` under the current Node ABI
  after `npm rebuild better-sqlite3`; packaging changes the native ABI and
  requires the documented rebuild/clean-install boundary below.
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
  The lockfile now pins safe transitive versions through npm overrides:
  `protobufjs@7.6.6` (including the Signal dependency) and `uuid@11.1.1`
  (including the speech dependency). `npm audit --omit=dev` reports zero
  findings on September 11, 2026. These overrides must be rechecked whenever
  Baileys, libsignal or vosk-browser is upgraded.
- The full development graph may still report advisories in tooling that is
  excluded from the production bundle; release review must keep production
  and development audit results separate.

Latest local verification (`npm run check:runtime`, September 11, 2026):
Electron `44.3.0`, Electron executable present, `better-sqlite3` loaded under
Node ABI `115`, and every direct dependency reported a machine-readable
license. The command fails only on the declared Node minimum (`20.20.2` versus
`>=22.12.0`). This confirms native-module diagnostics but does not close the
Node runtime gate, approve GPL distribution, upstream advisories, production
signing/notarization, or a clean release-host package.

The runtime verifier also performs a Signal key-generation smoke check and
prints the resolved `protobufjs` and `uuid` versions, so the security overrides
are checked for basic libsignal compatibility rather than only being accepted
from the lockfile.

The checklist item remains open until dependency-license review, production
signing/notarization and a clean release-host package run are recorded. The
Node 22 runtime check, Electron 44 native rebuild and application build have
now been verified. The production advisory gate is currently green on the
lockfile used here; license and release-host evidence remain open.

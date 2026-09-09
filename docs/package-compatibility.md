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
- The host currently runs Node `20.20.2`; this is below the supported engine.
- Electron resolves to `40.0.0`, but its platform executable is absent from
  `node_modules/electron/dist`, so packaged-Electron execution has not been
  verified in this checkout.
- Native modules include `better-sqlite3` and libsignal. Their Electron ABI
  rebuild and packaged launch must be verified on a supported Node/Electron
  build host.
- `@whiskeysockets/libsignal-node` reports `GPL-3.0`; distribution licensing
  review is required before shipping a production bundle. This is an explicit
  legal gate, not an automated approval.

The checklist item remains open until a clean install on Node 22.12+ passes the
runtime check, the required native modules are rebuilt for Electron 40, a
packaged app launches, and dependency-license review is recorded.

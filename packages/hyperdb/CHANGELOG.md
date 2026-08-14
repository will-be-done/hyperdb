# @will-be-done/hyperdb

## 0.5.1

### Patch Changes

- 2287298: Speed up repeated SQLite `loadTables()` calls with persisted schema signatures
  and make SQLite schema reconciliation handle identifiers case-insensitively.
  Ensure rejected async driver commands run generator cleanup, including
  transaction rollback and lock release.

## 0.5.0

### Minor Changes

- cdb4b1f: Allow `AsyncSqlDriver` operations to continue after the database rejects the
  start of a transaction.

## 0.4.4

### Patch Changes

- a003875: Improve work with indexes

## 0.4.3

### Patch Changes

- 53a6916: catch firefox idb tx finish
- 0678e07: add long redonly tx

## 0.4.2

### Patch Changes

- b39fb14: remove console.log logging

## 0.4.1

### Patch Changes

- dbe309d: fix hook strict mode race condition

## 0.4.0

### Minor Changes

- ef8ff80: improve hook
- 7a6c691: Rename the React synchronous dispatch hook from `useDispatch` to `useSyncDispatch`.

## 0.3.0

### Minor Changes

- eab2183: Added uniqhash, delayed persist. Added "in-mem" label to devtool traces

## 0.2.0

### Minor Changes

- efb7ce0: Add hybriddb + better selector + preloader

## 0.1.0

### Minor Changes

- cb0c89d: add HybridDB runtime. Improve react hooks

## 0.0.4

### Patch Changes

- 609ca09: bump version

## 0.0.3

### Patch Changes

- dbc1b5d: version bump check

## 0.0.2

### Patch Changes

- a40fe17: verion bump for check

## 0.0.1

### Patch Changes

- 19096b0: Prepare HyperDB for npm publishing with built package entrypoints.
- 216ccbd: Move the React devtool into a standalone package and remove the goober dependency from HyperDB core.

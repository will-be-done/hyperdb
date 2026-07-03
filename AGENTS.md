When you do any changes to packages/hyperdb or packages/hyperdb-devtool,
make sure that you covered it at packages/hyperdb-doc and root README.md.
Use packages/hyperdb-doc/summary.md to find which docs pages likely need to be
updated for the change.
Also update packages/hyperdb-doc/src/content/docs/start/llm-cheat-sheet.md
whenever the public API, package entry points, common usage patterns, or
capabilities change. But doc is public, so it doesn't need implementation details.

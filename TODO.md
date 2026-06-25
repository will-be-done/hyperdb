Github:

1. DONE Setup description, tags, auto-releaser

stackblitz:

1. DONE Add demo

Devtool:

1. resetcss
1. fix tabl selection (like call tree) not persisted to local storage
1. for hybrid db - mark whic data was loaded from cahce and which from persistent storage

Doc:

1. Make font be local
1. Maybe reframe it and remove mention about sync nature? amybe even async by default?
1. review index.mdx, start/\*(execpt why), index.md, in-memory-persistence.md
1. Add performance compare doc
1. On index page - embed stackblitz
1. Maybe rmeove "$" restriction?
1. Add quick guide to paste to llm or skill
1. DONE Fix npm install/doc links
1. DONE Remove wa-sqlite from hyperdb-lib. Move wa-sqlite support to recipe
1. DONE Add screenshot of code to the home page
1. DONE Add demo page with devtool
1. DONE Name package is @hyperdb/hyperdb
1. DONE Remove SyncDB from doc
1. DONE Generate icon, favicon
1. DONE Check all links
1. DONE Update "start here" links
1. DONE Ask make beaturfil deign using frontend design skill
1. DONE Create new repo and setup release flow with changeset or skill
1. DONE Beatiful design
1. DONE Release and make codesandbox screenshot to put it to landing page
1. DONE adopt styling of trpc
1. DONE move devtool to separate package

Others:

1. Understand when normalisation happen. Does it happened in-mem? Indexeddb? When validation happen?
1. intent skills css tanstack support
1. On release - cp readme.md to hyperdb/readme.md

DB:

1. start readonly transaction for one selector, if not cached data appeared for hybrid db, and reuse it for other selectors too. Also, don't wait commit to finish for readonly txes. It also means that now beginTx() will accpes modes - readonly | readwrite
2. (? maybe) CoW if new cloned btree appeared. But it still will be locked by idb transaction
3. Allow disable/enable logging of sqlite/idb. Disabled by default
4. Renamer upsert -> put ?
5. Is there any bulk insert for indexeddb?

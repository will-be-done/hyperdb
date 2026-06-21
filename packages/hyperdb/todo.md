TODO:

1. DONE Fix suggestion from codex
1. DONE after callback should accept same queries
1. DONE Generate demo and check profile on bit inserts/selects
1. DONE How to make counters? Hooks?
1. DONE remove runQuery(). Just yield\*(maybe?)
1. DONE start index with by...
1. DONE Move code by files/dirs. Follow convention
1. DONE eslint circular ref linter: cycle check uses dependency-cruiser (script: lint:cycles)
1. DONE check that eslint dependency-cruiser plugin really works
1. DONE Check if code has race condition. Maybe selector.ts has race condition? And subscribable-db.ts
1. DONE Use driver-edge-cases to runtime. driver-edge-cases.test.ts covers runtime DB/SyncDB. Also why db.ts and index.ts?
1. DONE Ask if that approach overall good. Passing data with tree
1. DONE check that utf8 sorting of string is same in js
1. DONE devtool
1. DONE Add firstOr(), first()
1. DONE Check devtool for tansatack table
1. DONE IMPORTANT - check how to make sure that devtool will have named queries/mutations
1. DONE Rename selector -> query; action -> mutation?
1. DONE better naming query/mutation. But if name query, then what is selectFrom() - . Actually maybe current naming is good. Action, selectors, query = selectFrom, mutation = insert/upsert/delete
1. DONE Value - add bigint/arraybuffer support
1. DONE Move web to new useSyncSelector syntax
1. DONE Make sure that cache layer same as in reselect
1. DONE Integrate to will be done
1. DONE Refactor UI with claude code
1. DONE remove child cache? Only collect root cache?
1. DONE genearate small readme
1. DONE Ask gpt: Check if args validation turned on(maybe add createSelector() createAction()?), rows on insert/updade is validated too.
1. DONE Turn on arguments validation with db options
1. DONE Rename query -> select dir
1. DONE rename autoTrace
1. DONE fix initall inserts are not tracing of will be done
1. DONE clear at devtool doens't work
1. Rename DevTools -> DevTool
1. Generate docs

TODO for devtool:

1. DONE Polisj UI. Remove flickering. Maybe adopt UI from livestore
2. DONE Rename data -> query
3. WONTFIX In devtool - maybe use db to store traces?
4. DONE Display how much rows were selected during query in general list
5. DONE Keep same tab open when change action/selector
6. DONE newValue always dilsplay as "circualr". Maybe just display array of oldValue and newValues, without status/startedAt/
7. DONE Don't open new db traces inew db appeared. Just keep current selected db
8. DONE somehow always collect traces event when closed, if devtool is mounted(and not opened)
9. DONE Devtool doens't work correctly with async flow
10. DONE Add ability to hide some selectors from devtools
11. DONE Vertical resize of devtool
12. DONE When clear events - db select still should be present
13. DONE Show any actions run, but if it was cached - show as cached
14. DONE Use hyperdb for traces
15. DONE Add selectors | actions tabs
16. DONE Add ability to sort by duration
17. DONE Give dbName so devtool looks better

devtool maybe:

1. Mutation - show button display diff. Also, add pagination if too much mutations
1. Data diff/change?
1. Ability to edit rows?
1. In devtool makr some selectors as [not cacheable]. Remove throws?

Then:

1. Nested index
1. When querying index - keep same order in query builder
1. Index name should start by...
1. DONE dev tool. Check tinybase. Check powersync
1. parallel async requests for async drivers
1. ? optimize SubscribableDBTx
1. remove ability to run code with promise

Maybe:

1. filter
1. play with effect-ts
1. ability to change data in devtool

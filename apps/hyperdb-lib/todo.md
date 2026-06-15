TODO: 

1. DONE Fix suggestion from codex
1. DONE after callback should accept same queries
1. DONE Generate demo and check profile on bit inserts/selects
1. DONE How to make counters? Hooks?
1. DONE remove runQuery(). Just yield*(maybe?)
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
1. Rename query -> select dir
1. Make validation as param when insert/update/delete
1. DONE Move web to new useSyncSelector syntax
1. DONE Make sure that cache layer same as in reselect
1. Turn on arguments validation with db options
1. DONE Integrate to will be done
1. DONE Refactor UI with claude code
1. rename autoTrace
1. remove child cache? Only collect root cache?
1. Generate docs

TODO for devtool:
1. DONE Polisj UI. Remove flickering. Maybe adopt UI from livestore
2. DONE Rename data -> query
1. WONTFIX In devtool - maybe use db to store traces?
1. DONE Display how much rows were selected during query in general list
1. DONE Keep same tab open when change action/selector
1. newValue always dilsplay as "circualr". Maybe just display array of oldValue and newValues, without status/startedAt/
1. DONE Don't open new db traces inew db appeared. Just keep current selected db
1. DONE somehow always collect traces event when closed, if devtool is mounted(and not opened)
1. DONE Devtool doens't work correctly with async flow
1. DONE Add ability to hide some selectors from devtools
1. DONE Vertical resize of devtool
1. DONE When clear events - db select still should be present
1. DONE Show any actions run, but if it was cached - show as cached

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

@insertProject [200ms]
  select projects.byId [50ms] [1 row]
  insert projects [50ms] [5 rows]
  select tasks.byProjectId [50ms] [2 rows]
  @insertFirstTask [50ms]
    select tasks.byId [20ms] [1 row]
    insert tasks [30ms] [2 rows]

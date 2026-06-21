import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BptreeInmemDriver } from "@will-be-done/hyperdb/drivers/inmemory";
import { DB, SubscribableDB, execSync } from "@will-be-done/hyperdb";
import { DBProvider } from "@will-be-done/hyperdb/react";
import App from "./App.tsx";
import {
  projectsTable,
  projectTaskStatsTable,
  tasksTable,
  taskStatsTable,
} from "./db.ts";
import "./index.css";
import { installTaskStatsHooks } from "./count-hook.ts";

const baseDb = new DB(new BptreeInmemDriver(), {
  freezeArgs: false,
  freezeRows: false,
});
execSync(
  baseDb.loadTables([
    projectsTable,
    tasksTable,
    taskStatsTable,
    projectTaskStatsTable,
  ]),
);
const db = new SubscribableDB(baseDb);
installTaskStatsHooks(db);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DBProvider value={db}>
      <App />
    </DBProvider>
  </StrictMode>,
);

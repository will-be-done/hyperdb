import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BptreeInmemDriver } from "@will-be-done/hyperdb/drivers/inmemory";
import { DB, SubscribableDB, execSync } from "@will-be-done/hyperdb";
import { DBProvider } from "@will-be-done/hyperdb/react";
import App from "./App.tsx";
import {
  hyperdbDemoDbOptions,
  hyperdbDemoTables,
  installTaskStatsHooks,
} from "./db.ts";
import "./index.css";

const baseDb = new DB(new BptreeInmemDriver(), hyperdbDemoDbOptions);
execSync(baseDb.loadTables(hyperdbDemoTables));
const db = new SubscribableDB(baseDb);
installTaskStatsHooks(db);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DBProvider value={db}>
      <App />
    </DBProvider>
  </StrictMode>,
);

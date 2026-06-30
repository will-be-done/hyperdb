import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DBProvider } from "@will-be-done/hyperdb/react";
import App from "./App.tsx";
import { initStore } from "./stores.ts";
import { getStoredMode } from "./store-mode.ts";
import { PersistenceProvider } from "./persistence-context.tsx";
import "./index.css";

const { db, persistence } = await initStore(getStoredMode());

createRoot(document.getElementById("root")!).render(
  <DBProvider value={db}>
    <PersistenceProvider value={persistence}>
      <App />
    </PersistenceProvider>
  </DBProvider>,
);

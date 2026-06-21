import { HyperDBDevtools } from "@will-be-done/hyperdb-devtool/react";
import { BenchmarkApp } from "./BenchmarkApp";

function App() {
  return (
    <>
      <BenchmarkApp />
      <HyperDBDevtools
        position="bottom"
        buttonPosition="bottom-right"
        initialIsOpen
      />
    </>
  );
}

export default App;

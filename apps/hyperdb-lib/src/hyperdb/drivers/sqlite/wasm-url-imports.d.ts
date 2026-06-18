export {};

declare module "sql.js/dist/sql-wasm.wasm?url" {
  const url: string;
  export default url;
}

declare module "wa-sqlite/dist/wa-sqlite-async.wasm?url" {
  const url: string;
  export default url;
}


// Native SQLite using memory-only homes; resolve hook from offline-test-home.mjs.
// No database path is opened here; production storage is out of scope.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// Absolute source path avoids recursively resolving the intercepted package name.
const Database = require(new URL("../node_modules/better-sqlite3/lib/index.js", import.meta.url).pathname);
export default class OfflineDatabase extends Database {
  constructor(_filename, options) { super(":memory:", options); }
}

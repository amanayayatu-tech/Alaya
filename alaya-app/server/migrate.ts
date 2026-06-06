import "dotenv/config";
import { rawDb, runSchemaMigrations } from "./storage";

runSchemaMigrations();
rawDb.prepare("SELECT 1 AS ok").get();

console.log(JSON.stringify({
  status: "ok",
  action: "schema_migrated",
  database: process.env.ALAYA_DB_PATH ?? "data.db",
  timestamp: new Date().toISOString(),
}, null, 2));

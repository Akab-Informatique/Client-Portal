import { defineConfig } from "drizzle-kit";

// Generates SQL migrations into ./drizzle from server/db/schema.ts:
//   npm run db:generate
// Migrations are applied automatically when the server starts.
export default defineConfig({
  dialect: "postgresql",
  schema: "./server/db/schema.ts",
  out: "./drizzle",
});

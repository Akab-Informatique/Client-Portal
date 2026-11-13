import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// In production the server serves ./dist. A page address (/tv) must get the app, not a folder of dist
// (dist/tv/ is the lobby screen, which is only reached by /tv/index.html).
describe("production pages and the lobby screen", () => {
  const dist = path.join(process.cwd(), "dist");
  const built = fs.existsSync(path.join(dist, "index.html")) && fs.existsSync(path.join(dist, "tv", "index.html"));
  it.runIf(built)("/tv is the portal page, /tv/index.html the lobby screen", async () => {
    const { createApp } = await import("../server/app.ts");
    const app = createApp();
    const appPage = fs.readFileSync(path.join(dist, "index.html"), "utf8");
    const screen = fs.readFileSync(path.join(dist, "tv", "index.html"), "utf8");
    const page = await (await app.request("/tv")).text();
    expect(page).toBe(appPage);
    expect(await (await app.request("/tv/")).text()).toBe(appPage);
    expect(await (await app.request("/tv/index.html")).text()).toBe(screen);
  });
});

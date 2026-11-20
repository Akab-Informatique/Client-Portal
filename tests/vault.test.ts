import { describe, expect, it } from "vitest";
import { ACCESS_LAYOUT, SYSTEM_ROLES } from "../shared/permissions.ts";

describe("Vault page (My IT tools)", () => {
  it("is a right of its own, in My IT tools, given to technicians", () => {
    expect(ACCESS_LAYOUT.find((s) => s.key === "ittools")?.modules).toContain("vault");
    const tech = SYSTEM_ROLES.find((r) => r.slug === "technician");
    expect(tech?.permissions).toContain("vault.use");
  });

  it("lets only vault.akab.ca be framed, beside the video player", async () => {
    const { createApp } = await import("../server/app.ts");
    const res = await createApp().request("/api/health");
    const csp = res.headers.get("content-security-policy") ?? "";
    const frames = /frame-src ([^;]*)/.exec(csp)?.[1] ?? "";
    expect(frames).toContain("https://vault.akab.ca");
    expect(frames).not.toContain("*");
  });
});

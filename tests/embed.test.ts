import { afterEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV = "test";

/** createApp() with the given environment, fresh (config is read once when it is loaded). */
async function appWith(env: Record<string, string>) {
  vi.resetModules();
  for (const k of ["EMBED_ORIGINS", "EMBED_CROSS_SITE_COOKIE", "COOKIE_SECURE"]) delete process.env[k];
  Object.assign(process.env, env);
  const { createApp } = await import("../server/app.ts");
  return createApp();
}

afterEach(() => {
  for (const k of ["EMBED_ORIGINS", "EMBED_CROSS_SITE_COOKIE", "COOKIE_SECURE"]) delete process.env[k];
});

describe("embedding the portal in another site", () => {
  it("only exact https origins are accepted; anything loose is dropped", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { parseEmbedOrigins } = await import("../server/config.ts");
    expect(parseEmbedOrigins("https://imago.example.com", true)).toEqual(["https://imago.example.com"]);
    expect(parseEmbedOrigins("https://a.example.com, https://b.example.com:8443  https://a.example.com", true)).toEqual(["https://a.example.com", "https://b.example.com:8443"]);
    // never a wildcard, a path, credentials, a bare word, or plain http (except localhost outside production)
    expect(parseEmbedOrigins("https://*.example.com https://x.example.com/app https://u:p@x.example.com http://x.example.com x.example.com *", true)).toEqual([]);
    expect(parseEmbedOrigins("http://localhost:5173", true)).toEqual([]);
    expect(parseEmbedOrigins("http://localhost:5173", false)).toEqual(["http://localhost:5173"]);
    expect(parseEmbedOrigins("", true)).toEqual([]);
  });

  it("by default nobody can frame the portal (frame-ancestors 'self', X-Frame-Options SAMEORIGIN)", async () => {
    const app = await appWith({});
    const r = await app.request("/nothing-here");
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/frame-ancestors 'self'(;|$)/);
    expect(r.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("an allowed site is named in frame-ancestors and X-Frame-Options (which cannot name a second site) is dropped; the rest of the policy stays", async () => {
    const app = await appWith({ EMBED_ORIGINS: "https://imago.example.com" });
    const r = await app.request("/nothing-here");
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'self' https://imago.example.com");
    expect(r.headers.get("x-frame-options")).toBeNull();
    // still locked down: own scripts only, own forms, no <base> tricks
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("base-uri 'self'");
    // a loose entry opens nothing
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const loose = await (await appWith({ EMBED_ORIGINS: "*" })).request("/nothing-here");
    expect(loose.headers.get("content-security-policy")).toMatch(/frame-ancestors 'self'(;|$)/);
    expect(loose.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("the cross-site cookie mode needs HTTPS cookies and an allowed site", async () => {
    vi.resetModules();
    process.env.EMBED_CROSS_SITE_COOKIE = "true";
    delete process.env.EMBED_ORIGINS;
    process.env.COOKIE_SECURE = "true";
    expect((await import("../server/config.ts")).config.embedCrossSiteCookie).toBe(false); // no allowed site
    vi.resetModules();
    process.env.EMBED_ORIGINS = "https://imago.example.com";
    expect((await import("../server/config.ts")).config.embedCrossSiteCookie).toBe(true);
    vi.resetModules();
    process.env.COOKIE_SECURE = "false"; // plain http: SameSite=None would be refused by browsers
    expect((await import("../server/config.ts")).config.embedCrossSiteCookie).toBe(false);
  });
});

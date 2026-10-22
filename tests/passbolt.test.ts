import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as openpgp from "openpgp";
import { KeyHolder, PassboltError, listResources, login, readSecret, unlockKey, type Transport } from "../src/lib/passbolt/client.ts";

/**
 * The browser side of Sécurité › Passbolt, against a small fake Passbolt (made here, with fake keys and fake
 * secrets): sign in with a signed challenge, the server proving itself by its signature, listing (Passbolt 4
 * names in the clear, Passbolt 5 names in encrypted metadata), reading a secret.
 */
const BASE = "https://passbolt.test";
const PASS = "correct horse battery staple";
const USER_ID = "11111111-2222-4333-8444-555555555555";
const RES = { plain: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", json: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", v5: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", v5user: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" };

let userArmored = "";
let userPublic: openpgp.Key;
let serverPrivate: openpgp.PrivateKey;
let serverPublic: openpgp.Key;
let metaKey: openpgp.PrivateKey;
let metaKeyArmored = "";
let rogue: openpgp.PrivateKey;
let signWith: "server" | "rogue" = "server";

const gen = async (name: string, passphrase?: string) => openpgp.generateKey({ type: "ecc", curve: "curve25519Legacy", userIDs: [{ name, email: `${name}@test.example` }], passphrase, format: "object" });
const enc = async (text: string, to: openpgp.Key, sign?: openpgp.PrivateKey) => openpgp.encrypt({ message: await openpgp.createMessage({ text }), encryptionKeys: to, ...(sign ? { signingKeys: sign } : {}) });

beforeAll(async () => {
  const user = await gen("user", PASS);
  userArmored = user.privateKey.armor();
  userPublic = user.publicKey;
  const server = await gen("server");
  serverPrivate = server.privateKey;
  serverPublic = server.publicKey;
  rogue = (await gen("rogue")).privateKey;
  const m = await gen("metadata");
  metaKey = m.privateKey;
  metaKeyArmored = m.privateKey.armor();
});
afterAll(() => vi.useRealTimers());

/** The fake Passbolt */
const fake: Transport = async (method, path, opts = {}) => {
  const json = (status: number, body: unknown) => ({ status, json: { header: { message: status < 300 ? "ok" : "refused" }, body } });
  if (method === "GET" && path === "/auth/verify.json") return json(200, { keydata: serverPublic.armor(), fingerprint: serverPublic.getFingerprint() });
  if (method === "POST" && path === "/auth/jwt/login.json") {
    const body = opts.body as { user_id: string; challenge: string };
    if (body.user_id !== USER_ID) return json(404, null);
    const { data, signatures } = await openpgp.decrypt({ message: await openpgp.readMessage({ armoredMessage: body.challenge }), decryptionKeys: serverPrivate, verificationKeys: userPublic });
    await signatures[0].verified; // the person signed it
    const c = JSON.parse(String(data));
    if (c.domain !== BASE) return json(403, null);
    const answer = JSON.stringify({ version: "1.0.0", domain: BASE, verify_token: c.verify_token, access_token: "jwt-access", refresh_token: "jwt-refresh" });
    return json(200, { challenge: await enc(answer, userPublic, signWith === "server" ? serverPrivate : rogue) });
  }
  if (opts.token !== "jwt-access") return json(401, null);
  if (method === "GET" && path === "/resources.json") {
    return json(200, [
      { id: RES.plain, name: "Routeur du client", username: "admin", uri: "https://router.test", description: "" },
      {
        id: RES.v5,
        metadata: await enc(JSON.stringify({ name: "Serveur NAS", username: "root", uris: ["https://nas.test"], description: "Salle 2" }), metaKey.toPublic()),
        metadata_key_id: "mk-1",
        metadata_key_type: "shared_key",
      },
      { id: RES.v5user, metadata: await enc(JSON.stringify({ name: "Perso", username: "me" }), userPublic), metadata_key_id: null, metadata_key_type: "user_key" },
      { id: RES.json, name: "Wifi", username: "", uri: "" },
    ]);
  }
  if (method === "GET" && path === "/metadata/keys.json") {
    return json(200, [{ id: "mk-1", metadata_private_keys: [{ user_id: USER_ID, data: await enc(JSON.stringify({ object_type: "PASSBOLT_METADATA_PRIVATE_KEY", armored_key: metaKeyArmored, passphrase: "" }), userPublic) }] }]);
  }
  const s = path.match(/^\/secrets\/resource\/(.+)\.json$/);
  if (method === "GET" && s) {
    const text = s[1] === RES.json ? JSON.stringify({ password: "wifi-p@ss", description: "invités" }) : "plain-secret-123";
    return json(200, { resource_id: s[1], user_id: USER_ID, data: await enc(text, userPublic) });
  }
  return json(404, null);
};

describe("Passbolt from the browser (fake server, fake keys)", () => {
  it("unlocks the key with the passphrase only", async () => {
    await expect(unlockKey(userArmored, "wrong")).rejects.toMatchObject({ code: "bad_passphrase" });
    await expect(unlockKey("not a key", PASS)).rejects.toMatchObject({ code: "bad_key" });
    expect((await unlockKey(userArmored, PASS)).isDecrypted()).toBe(true);
  });

  it("signs in with a signed challenge and checks the server's own signature", async () => {
    const key = await unlockKey(userArmored, PASS);
    signWith = "server";
    expect(await login(fake, key, USER_ID, BASE)).toEqual({ accessToken: "jwt-access", refreshToken: "jwt-refresh" });
    // a server that is not the one with the key it advertised
    signWith = "rogue";
    await expect(login(fake, key, USER_ID, BASE)).rejects.toMatchObject({ code: "server_signature" });
    signWith = "server";
    // an unknown user
    await expect(login(fake, key, "99999999-9999-4999-8999-999999999999", BASE)).rejects.toBeInstanceOf(PassboltError);
  });

  it("lists what the person can reach, decrypting the metadata of Passbolt 5; reads a secret; nothing without the token", async () => {
    const key = await unlockKey(userArmored, PASS);
    const list = await listResources(fake, "jwt-access", key);
    expect(list.map((r) => r.name)).toEqual(["Perso", "Routeur du client", "Serveur NAS", "Wifi"]);
    expect(list.find((r) => r.id === RES.v5)).toMatchObject({ username: "root", uri: "https://nas.test", description: "Salle 2" });
    expect(list.find((r) => r.id === RES.plain)).toMatchObject({ username: "admin", uri: "https://router.test" });
    expect(await readSecret(fake, "jwt-access", key, RES.plain)).toEqual({ password: "plain-secret-123", description: null });
    expect(await readSecret(fake, "jwt-access", key, RES.json)).toEqual({ password: "wifi-p@ss", description: "invités" });
    await expect(listResources(fake, "stolen", key)).rejects.toMatchObject({ code: "http" });
    // a secret that was not encrypted for this person cannot be read
    const other = (await gen("other")).privateKey;
    await expect(readSecret(fake, "jwt-access", other, RES.plain)).rejects.toMatchObject({ code: "decrypt" });
  });

  it("the key in memory locks by itself after the idle time, and on demand", async () => {
    vi.useFakeTimers();
    let locked = 0;
    const holder = new KeyHolder(60_000, () => locked++);
    expect(() => holder.get()).toThrow(PassboltError);
    holder.set(await unlockKey(userArmored, PASS));
    expect(holder.unlocked).toBe(true);
    vi.advanceTimersByTime(50_000);
    holder.get(); // using it pushes the lock back
    vi.advanceTimersByTime(50_000);
    expect(holder.unlocked).toBe(true);
    vi.advanceTimersByTime(20_000);
    expect(holder.unlocked).toBe(false);
    expect(locked).toBe(1);
    holder.set(await unlockKey(userArmored, PASS));
    holder.lock();
    expect(() => holder.get()).toThrow(PassboltError);
    vi.useRealTimers();
  });
});

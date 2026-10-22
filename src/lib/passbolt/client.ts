import * as openpgp from "openpgp";

/**
 * Passbolt from the browser (Sécurité › Passbolt, a spike). Everything that needs the person's private key
 * happens HERE: signing in to Passbolt (JWT: a challenge encrypted for the server and signed with their key),
 * and decrypting what they may see. The portal's server only forwards the calls (see server/lib/passbolt.ts)
 * and never gets a passphrase or a decrypted secret.
 *
 * Pure functions over a `Transport`, so they run the same in the browser and in tests.
 */
export class PassboltError extends Error {
  constructor(
    public code: "bad_passphrase" | "bad_key" | "login_failed" | "server_signature" | "http" | "decrypt" | "locked",
    public detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** One call to Passbolt (through the portal's forwarding). Gives back the parsed JSON Passbolt answered. */
export type Transport = (method: "GET" | "POST", path: string, opts?: { body?: unknown; token?: string; query?: string }) => Promise<{ status: number; json: any }>;

const ok = (r: { status: number; json: any }, what: string) => {
  if (r.status < 200 || r.status >= 300) throw new PassboltError("http", `${what}: ${r.status} ${r.json?.header?.message ?? ""}`.trim());
  return r.json?.body;
};

/** Unlock the private key with the passphrase (it stays in memory, never sent anywhere). */
export async function unlockKey(armoredKey: string, passphrase: string): Promise<openpgp.PrivateKey> {
  let key: openpgp.PrivateKey;
  try {
    key = await openpgp.readPrivateKey({ armoredKey });
  } catch {
    throw new PassboltError("bad_key");
  }
  try {
    return await openpgp.decryptKey({ privateKey: key, passphrase });
  } catch {
    throw new PassboltError("bad_passphrase");
  }
}

/** Sign in (JWT): returns the access token to use as a bearer token. */
export async function login(tr: Transport, key: openpgp.PrivateKey, passboltUserId: string, baseUrl: string): Promise<{ accessToken: string; refreshToken: string | null }> {
  // the server's public key
  const v = ok(await tr("GET", "/auth/verify.json"), "verify");
  const serverKey = await openpgp.readKey({ armoredKey: v.keydata });
  // the challenge: encrypted for the server, signed by the person
  const verifyToken = crypto.randomUUID();
  const challenge = JSON.stringify({ version: "1.0.0", domain: baseUrl.replace(/\/+$/, ""), verify_token: verifyToken, verify_token_expiry: Math.floor(Date.now() / 1000) + 120 });
  const armored = await openpgp.encrypt({ message: await openpgp.createMessage({ text: challenge }), encryptionKeys: serverKey, signingKeys: key });
  const body = ok(await tr("POST", "/auth/jwt/login.json", { body: { user_id: passboltUserId, challenge: armored } }), "login");
  if (!body?.challenge) throw new PassboltError("login_failed");
  // the answer: encrypted for the person, signed by the server (checked: this is how the server proves who it is)
  const { data, signatures } = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage: body.challenge }),
    decryptionKeys: key,
    verificationKeys: serverKey,
  });
  try {
    await signatures[0].verified;
  } catch {
    throw new PassboltError("server_signature");
  }
  const answer = JSON.parse(String(data)) as { verify_token?: string; access_token?: string; refresh_token?: string };
  if (answer.verify_token !== verifyToken || !answer.access_token) throw new PassboltError("login_failed");
  return { accessToken: answer.access_token, refreshToken: answer.refresh_token ?? null };
}

export type ResourceView = { id: string; name: string; username: string; uri: string; description: string };

type RawResource = {
  id: string;
  name?: string;
  username?: string;
  uri?: string;
  description?: string;
  /** Passbolt 5: the name, username, uri… are in this encrypted block */
  metadata?: string;
  metadata_key_id?: string | null;
  metadata_key_type?: "shared_key" | "user_key" | null;
};

/** The shared metadata keys (Passbolt 5), unlocked with the person's own key. */
async function metadataKeys(tr: Transport, token: string, key: openpgp.PrivateKey): Promise<Map<string, openpgp.PrivateKey>> {
  const out = new Map<string, openpgp.PrivateKey>();
  const r = await tr("GET", "/metadata/keys.json", { token, query: "contain[metadata_private_keys]=1&api-version=v2" });
  if (r.status === 404) return out;
  const keys = ok(r, "metadata keys") as { id: string; metadata_private_keys?: { user_id?: string | null; data: string }[] }[];
  for (const k of keys ?? []) {
    for (const p of k.metadata_private_keys ?? []) {
      try {
        const { data } = await openpgp.decrypt({ message: await openpgp.readMessage({ armoredMessage: p.data }), decryptionKeys: key });
        const j = JSON.parse(String(data)) as { armored_key: string; passphrase?: string };
        const priv = await openpgp.readPrivateKey({ armoredKey: j.armored_key });
        out.set(k.id, priv.isDecrypted() ? priv : await openpgp.decryptKey({ privateKey: priv, passphrase: j.passphrase ?? "" }));
        break;
      } catch {
        /* not for this person, or unreadable: next one */
      }
    }
  }
  return out;
}

/** What the person can reach: name, username, address (decrypting the metadata of Passbolt 5 when there is some). */
export async function listResources(tr: Transport, token: string, key: openpgp.PrivateKey): Promise<ResourceView[]> {
  const rows = (ok(await tr("GET", "/resources.json", { token, query: "api-version=v2" }), "resources") ?? []) as RawResource[];
  const shared = rows.some((r) => r.metadata && r.metadata_key_type !== "user_key") ? await metadataKeys(tr, token, key) : new Map<string, openpgp.PrivateKey>();
  const out: ResourceView[] = [];
  for (const r of rows) {
    let meta: { name?: string; username?: string; uris?: string[]; uri?: string; description?: string } = {};
    if (r.metadata) {
      try {
        const dk = r.metadata_key_type === "user_key" ? key : r.metadata_key_id ? shared.get(r.metadata_key_id) : undefined;
        if (dk) {
          const { data } = await openpgp.decrypt({ message: await openpgp.readMessage({ armoredMessage: r.metadata }), decryptionKeys: dk });
          meta = JSON.parse(String(data));
        }
      } catch {
        /* this entry's metadata cannot be read: shown without a name */
      }
    }
    out.push({
      id: r.id,
      name: r.name ?? meta.name ?? "—",
      username: r.username ?? meta.username ?? "",
      uri: r.uri ?? meta.uri ?? meta.uris?.[0] ?? "",
      description: r.description ?? meta.description ?? "",
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The secret of one entry, decrypted here. A plain password, or a JSON secret with a "password" (and a description). */
export async function readSecret(tr: Transport, token: string, key: openpgp.PrivateKey, resourceId: string): Promise<{ password: string; description: string | null }> {
  const s = ok(await tr("GET", `/secrets/resource/${resourceId}.json`, { token }), "secret");
  let text: string;
  try {
    const { data } = await openpgp.decrypt({ message: await openpgp.readMessage({ armoredMessage: s.data }), decryptionKeys: key });
    text = String(data);
  } catch {
    throw new PassboltError("decrypt");
  }
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object" && typeof j.password === "string") return { password: j.password, description: typeof j.description === "string" ? j.description : null };
  } catch {
    /* not JSON: the password itself */
  }
  return { password: text, description: null };
}

/** The key kept in memory only, locked again after a time or on demand. */
export class KeyHolder {
  private key: openpgp.PrivateKey | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private idleMs = 5 * 60_000, private onLock?: () => void) {}
  set(key: openpgp.PrivateKey) {
    this.key = key;
    this.touch();
  }
  get(): openpgp.PrivateKey {
    if (!this.key) throw new PassboltError("locked");
    this.touch();
    return this.key;
  }
  get unlocked() {
    return this.key !== null;
  }
  /** Each use pushes the lock back */
  touch() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.lock(), this.idleMs);
  }
  lock() {
    this.key = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.onLock?.();
  }
}

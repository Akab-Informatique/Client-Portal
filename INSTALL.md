# Install AKAB Portal (Docker)

One server with Docker. The portal listens on **port 3000** (plain HTTP); your
HTTPS reverse proxy (e.g. Nginx Proxy Manager) forwards
`https://portail.akab.ca` → `http://<server IP>:3000`.

| Container | Role |
|-----------|------|
| `app` | Web app + API (Node 22) |
| `db` | PostgreSQL 16 — data in volume `akab_pgdata` (**never delete it**) |

## 1. Install Docker (Debian; on Ubuntu replace `debian` with `ubuntu`)

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git openssl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
```

Log out and back in.

## 2. Get the code

```bash
sudo mkdir -p /opt && sudo chown "$USER":"$USER" /opt && cd /opt
git clone -b master https://github.com/Akab-Informatique/Client-Portal.git akab-portal
cd akab-portal
```

## 3. Create `.env`

```bash
cp .env.example .env
openssl rand -hex 16    # → POSTGRES_PASSWORD
openssl rand -hex 32    # → APP_SECRET
nano .env               # fill the REQUIRED block
chmod 600 .env
```

| Variable | Value |
|----------|-------|
| `POSTGRES_PASSWORD` | 1st generated value — never change it after the first start |
| `APP_SECRET` | 2nd generated value — encrypts MFA secrets **and every integration key** (Microsoft, QuickBooks, Stripe, VoIP.ms, Claude). Never change it, and back it up with the database (see Backup) |
| `PUBLIC_URL` | **Required**: `https://portail.akab.ca`. Without it, password and welcome emails are not sent |
| `ADMIN_EMAIL` / `ADMIN_NAME` | First administrator (created once) |
| `ADMIN_PASSWORD` | Leave empty → one-time password in the log (if set: 12 characters minimum, changed at the first sign-in) |
| `APP_PUBLISH` | `<this server's LAN IP>:3000` — so port 3000 is not open on every interface (see Firewall) |
| `TRUSTED_PROXY_IPS` | **Required behind Nginx Proxy Manager**: the proxy server's IP. Without it every visitor looks like the proxy: one person failing logins can block everyone, and the audit log shows the proxy's IP |
| `SMTP_*` | Optional — the mail server can also be set later in **Admin settings › Courriels** (that setting wins over `.env`) |

## 4. Start

```bash
docker compose up -d --build
docker compose ps                                   # app + db "healthy"
docker compose logs app | grep "one-time password"  # first admin password
```

Open `https://portail.akab.ca`, sign in with `ADMIN_EMAIL` and that password,
set up MFA with your authenticator app, then choose your own password.

## 5. Microsoft 365 (Outlook and calendars) — optional

One app registration in AKAB's Microsoft Entra, then **Admin settings ›
Intégrations › Microsoft 365** (tenant ID, application ID, client secret).
`PUBLIC_URL` must be set: the sign-in comes back to it.

1. Entra ID › App registrations › New registration ("Portail AKAB"), accounts
   in this directory only.
2. Authentication › Add a platform › **Web** › redirect URI: the address shown
   on the portal's Microsoft 365 page (`https://portail.akab.ca/api/microsoft/callback`).
3. API permissions › Microsoft Graph:
   - **Delegated** (each technician signs in themselves, profile › Microsoft 365):
     `User.Read`, `offline_access`, `Mail.ReadWrite`, `Mail.Send`, `Mail.ReadWrite.Shared`, `Mail.Send.Shared`, `Calendars.ReadWrite`
     (the two `.Shared` ones let a technician link a mailbox shared with them in Exchange, e.g. support@;
     Microsoft refuses any mailbox they have no access to).
   - **Application** (organisation access, master administrators only: anyone's
     calendar, shared mailboxes): `Calendars.ReadWrite`, `Mail.ReadWrite`, `Mail.Send`.
   - **Grant admin consent**.
4. Certificates & secrets › New client secret → paste it in the portal.

The application permissions reach every mailbox of the tenant. To limit them,
use an Exchange application access policy (`New-ApplicationAccessPolicy`).

## Upgrade (keeps all data)

```bash
cd /opt/akab-portal
git pull
docker compose up -d --build
```

Database migrations run automatically when the app starts.

## Firewall

Port 3000 is plain HTTP: only Nginx Proxy Manager should reach it. Docker's
published ports bypass `ufw`, so filter in Docker's own chain (replace
`192.168.1.20` with the proxy server's IP):

```bash
sudo iptables -I DOCKER-USER -p tcp --dport 3000 ! -s 192.168.1.20 -j DROP
sudo apt install -y iptables-persistent && sudo netfilter-persistent save
```

In Nginx Proxy Manager, turn off the access log (or query strings) for
`/api/sms/hook`: VoIP.ms sends its secret token in the address. If that log
was ever shared, make a new token in **Admin settings › Intégrations › VoIP.ms**.

## Backup

The database **and** `.env` (its `APP_SECRET` decrypts every saved key and
MFA secret: a database restored with another `APP_SECRET` loses them all).

```bash
docker compose exec -T db pg_dump -U akab akab | gzip > akab-$(date +%F).sql.gz
chmod 600 akab-*.sql.gz
```

Every night, keeping 30 days, then copy `/opt/akab-backups` off this server
(another machine, a NAS, cloud storage):

```bash
sudo mkdir -p /opt/akab-backups && sudo chmod 700 /opt/akab-backups
sudo cp /opt/akab-portal/.env /opt/akab-backups/env.backup && sudo chmod 600 /opt/akab-backups/env.backup
( sudo crontab -l 2>/dev/null; echo '30 2 * * * cd /opt/akab-portal && docker compose exec -T db pg_dump -U akab akab | gzip > /opt/akab-backups/akab-$(date +\%F).sql.gz && find /opt/akab-backups -name "akab-*.sql.gz" -mtime +30 -delete' ) | sudo crontab -
```

Restore (test it once, on another machine):

```bash
gunzip -c akab-YYYY-MM-DD.sql.gz | docker compose exec -T db psql -U akab akab
```

Run a single copy of the app (one `app` container): its background jobs and
invoice numbering assume one instance.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `POSTGRES_PASSWORD is missing` | No `.env` in this folder, or the line is empty |
| `APP_SECRET is missing …` in the log | Fill `APP_SECRET` (openssl rand -hex 32) |
| Proxy shows **502 Bad Gateway** | `docker compose ps`; check IP/port and scheme **http** in the proxy |
| Login loops back to sign-in | Site must be served over HTTPS (secure cookies) |
| `password authentication failed` | `POSTGRES_PASSWORD` changed after first start — restore the original |
| Lost MFA device | Another admin: Admin settings → user → Security → Reset MFA |
| Lost the first admin one-time password / cannot sign in | `docker compose exec app node --import tsx server/cli/reset-admin.ts` lists the accounts; add the email (and `--mfa` to also reset MFA) to print a new one-time password |
| Forgotten password | "Mot de passe oublié ?" on the sign-in page (needs a mail server), or another admin: user → Security |

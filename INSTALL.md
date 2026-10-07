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
| `APP_SECRET` | 2nd generated value — encrypts MFA secrets |
| `PUBLIC_URL` | `https://portail.akab.ca` |
| `ADMIN_EMAIL` / `ADMIN_NAME` | First administrator (created once) |
| `ADMIN_PASSWORD` | Leave empty → one-time password in the log |
| `APP_PUBLISH` | `3000` (or `IP:3000`) |
| `TRUSTED_PROXY_IPS` | Recommended: your reverse proxy's IP |
| `SMTP_*` | Email copies of board messages (optional) |

## 4. Start

```bash
docker compose up -d --build
docker compose ps                                   # app + db "healthy"
docker compose logs app | grep "one-time password"  # first admin password
```

Open `https://portail.akab.ca`, sign in with `ADMIN_EMAIL` and that password,
set up MFA with your authenticator app, then choose your own password.

## Upgrade (keeps all data)

```bash
cd /opt/akab-portal
git pull
docker compose up -d --build
```

Database migrations run automatically when the app starts.

## Backup

```bash
docker compose exec -T db pg_dump -U akab akab | gzip > akab-$(date +%F).sql.gz
chmod 600 akab-*.sql.gz
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `POSTGRES_PASSWORD is missing` | No `.env` in this folder, or the line is empty |
| `APP_SECRET is missing …` in the log | Fill `APP_SECRET` (openssl rand -hex 32) |
| Proxy shows **502 Bad Gateway** | `docker compose ps`; check IP/port and scheme **http** in the proxy |
| Login loops back to sign-in | Site must be served over HTTPS (secure cookies) |
| `password authentication failed` | `POSTGRES_PASSWORD` changed after first start — restore the original |
| Lost MFA device | Another admin: Admin settings → user → Security → Reset MFA |

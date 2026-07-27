# Changelog

All notable changes to **AKAB Portal** are documented in this file.

## [1.0.0] — 2026-07-27

### Added
- Client portal zones (per company) with role-based admin / technician / client access
- Autotask PSA integration: open tickets, detail, reply, close, elevation request
- SharePoint / Microsoft Graph documentation browser (portal defaults + **per-client** Entra app credentials)
- Message board per client zone
- Staff & roles, permissions, dashboard layout customizer
- EN / FR localization and light / dark theme
- Production self-host server (`npm start`), Docker image, Vercel config
- Demo seed data for local evaluation

### Fixed
- Autotask error payloads (`{ code, id, message }`) no longer crash React
- Clearer HTTP 410 (zone/API path) messaging for Autotask
- Graph auth isolation per company (tenant + client id + secret)

### Security notes for operators
- Never commit `.env`
- Prefer server-side secrets; per-client Graph secrets are stored on company records (encrypt at rest in production DB)
- PGlite is browser-local — for multi-user production, plan a shared Postgres/Supabase backend

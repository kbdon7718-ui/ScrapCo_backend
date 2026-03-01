## ScrapCo Backend – Forensic Architecture & Security Audit

### Phase 1 — Backend Architecture Audit
- **Framework:** Express 4.x (commonjs).
- **Runtime:** Node.js ≥20 (via supabase-js engines). No explicit engines field; dotenv autoload in `index.js`.
- **Database:** Supabase/PostgreSQL (primary), optional in-memory fallback and optional local Postgres via `db/client.js`.
- **ORM/ODM:** None; uses `@supabase/supabase-js` query builder and raw SQL migrations. Optional `pg` Pool for local DB.
- **Authentication:** Client JWT Bearer from Supabase Auth for customer endpoints; HMAC (`x-scrapco-signature` with `VENDOR_WEBHOOK_SECRET`) for vendor callbacks; admin/dev endpoints gated only by env flags (no user auth); `/api/vendor/location` intentionally unauthenticated.
- **Env handling:** `dotenv` in `index.js`; `supabase/client.js` throws if required keys missing (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`). Additional envs: `VENDOR_WEBHOOK_SECRET`, `VENDOR_API_TOKEN`, `ALLOW_ADMIN_PORTAL`, `ALLOW_DEV_BYPASS`, `PORT`, optional dev IDs/passwords.
- **Config strategy:** Ad-hoc env vars; no config layering/validation beyond required Supabase keys.
- **Deployment assumptions:** Single Express process; background timers in-memory; Render instructions in README; CORS open; no process manager noted.

**Executive Summary**
- **What it is:** Minimal Express API for scrap pickup orchestration backed by Supabase/Postgres with vendor dispatch logic and admin helpers.
- **Does well:** Clear Supabase integration; RLS-aware RPC usage; defensive fallbacks when migrations absent; dispatch timeouts handled; informative logging.
- **Fragile areas:** In-memory dispatch state lost on restart; no rate limiting/helmet; admin/dev bypass lack auth; vendor location endpoint unauthenticated; CORS wide open; no tests/CI beyond agent; README currently contains binary/null characters (encoding issue to clean up); mixed DB strategies (Supabase vs local pg vs in-memory) complicate consistency.
- **Maturity:** MVP/early pilot, not production-ready without hardening.

**Architecture Diagram (text)**
```
Client (mobile/web) -> Express app
  Middleware: cors (open) -> express.json(rawBody captured) -> request logger
  Routers:
    /api/pickups -> validations -> Supabase anon client (JWT) RPCs/tables -> dispatcher background
    /api/vendor -> HMAC check -> Supabase service role updates -> dispatcher state transitions
    /api/admin -> env-flag gate -> Supabase service role CRUD on scrap types/rates/vendors
  Services:
    dispatcher -> Supabase service role queries -> vendor_backends offer_url -> HTTP POST to vendor backend
    supabase/client -> builds anon/service/public clients from env
    vendor/security -> HMAC verification using rawBody + secret
Data layer:
  Supabase/Postgres tables (pickups, pickup_items, scrap_types, scrap_rates, vendor_backends, pickup_vendor_rejections, profiles)
  Optional local pg schema + in-memory fallback (data/store)
External integrations:
  Supabase API, vendor backend offer URLs (HTTP), optional Render deploy
Background:
  dispatcher sweeper interval (10s) + per-offer timers in-memory
```

**Folder Structure (top-level)**
- `index.js` – Express entrypoint, middleware, router wiring, server start.
- `routes/` – Route handlers for pickups, vendor callbacks, admin, dev orders, scrap types (not mounted).
- `services/dispatcher.js` – Vendor dispatch, offer fanout, timers, state machine.
- `supabase/` – Client factory, auth helper, dev bypass helper, SQL migrations.
- `db/` – Optional pg Pool client + schema bootstrap.
- `data/` – In-memory datastore fallback.
- `vendor/` – HMAC signature verification utilities.
- `tools/` – Manual Supabase auth test script.
- `supabase/migrations/` – SQL for RLS, RPCs, status enums, vendor tables.
- `node_modules/` – Installed dependencies.

**Dependency Risk Report**
- Major deps: express 4.19, @supabase/supabase-js 2.56/2.91, node-fetch 2.6 (legacy), cors 2.8, dotenv 17, pg (transitive for db). Dev: nodemon.
- Risks: `node-fetch@2` is deprecated and ESM-incompatible long-term; `cors@2.8.5` older; no lock on engines. Supabase 2.56 requires Node ≥20. No security middleware (helmet, rate limiting) present.

### Phase 2 — API Structure Analysis
| Method | Route | Auth | Input | Output | Description |
| --- | --- | --- | --- | --- | --- |
| GET | `/` | None | N/A | 404 (Express default 404 page because no route handler is defined) | Root is not a health check; no health endpoint exists today |
| POST | `/api/pickups/` | Supabase JWT (Bearer) | `{address,timeSlot,items:[{scrapTypeId,estimatedQuantity}], latitude?, longitude?}` | `201 {success,pickupId}` | Create pickup via RPC `create_pickup`, kicks off dispatch |
| GET | `/api/pickups/:id` | Supabase JWT | `id` param | `200 {success,pickup{...}}` | Fetch pickup with items + vendor enrichment + ETA heuristic |
| POST | `/api/pickups/:id/find-vendor` | Supabase JWT | `id` param | `200 {success,pickupId,status}` | Restart dispatch if not terminal |
| POST | `/api/pickups/:id/cancel` | Supabase JWT | `id` param | `200 {success,pickupId,status}` | Soft-cancel pickup |
| POST | `/api/pickups/accepted` | HMAC (`x-scrapco-signature`) | body with `pickupId` & `assignedVendorRef` | `200 {success,pickup}` | Vendor notify/confirm acceptance via dispatcher |
| POST | `/api/vendor/accept` | HMAC | body `pickupId`, `assignedVendorRef/vendor_id` | `200 {success,pickup}` | Vendor accepts offer (enforces assignment match & expiry) |
| POST | `/api/vendor/reject` | HMAC | body `pickupId`, `assignedVendorRef/vendor_id` | `200 {success,result}` | Vendor rejects offer; redispatch |
| POST | `/api/vendor/on-the-way` | HMAC | body `pickupId`, `assignedVendorRef/vendor_id` | `200 {success,pickup}` | Mark pickup ON_THE_WAY |
| POST | `/api/vendor/pickup-done` | HMAC | body `pickupId`, `assignedVendorRef/vendor_id` | `200 {success,pickup}` | Mark pickup COMPLETED |
| POST | `/api/vendor/location` | **Unauthenticated** | body `vendor_id`, `latitude`, `longitude`, `offer_url?` | `200 {success,vendor_id,updated_at}` | Upsert vendor location/offer URL |
| GET | `/api/admin/vendors` | Env gate (`ALLOW_ADMIN_PORTAL`/`ALLOW_DEV_BYPASS`) | N/A | `200 {success,vendors}` | List vendor_backends |
| GET | `/api/admin/scrap-types` | Env gate | N/A | `200 {success,scrapTypes}` | List scrap types with active rate |
| POST | `/api/admin/scrap-types` | Env gate | `{name}` | `201 {success,scrapType}` | Create scrap type |
| PATCH | `/api/admin/scrap-types/:id` | Env gate | `{name}` | `200 {success,scrapType}` | Update scrap type |
| POST | `/api/admin/scrap-rates` | Env gate | `{scrapTypeId, ratePerKg}` | `201 {success,rate}` | Set active rate (deactivates prior) |
| GET | `/api/orders` | Env gate (`ALLOW_DEV_BYPASS`) | N/A | `{success,count,orders}` | Dev-only list orders |
| GET | `/api/orders/:id` | Env gate (`ALLOW_DEV_BYPASS`) | `id` | `{success,order}` | Dev-only order detail |
| GET | `/api/scrap-types` | Not mounted in `index.js` | N/A | `{success,count,types}` | Public scrap types (defaults fallback) — currently unreachable |

**Findings**
- Response format mostly `{success,...}` but health/root not defined, some errors return plain text from Express default; admin gates return `{success:false,error}`.
- Validation: pickups validate required fields; vendor endpoints validate params; admin validates names/rates. No centralized schema validation (e.g., Joi/Zod).
- Error standardization limited; status codes mostly appropriate, but some 400 for internal Supabase errors.
- Versioning: none (`/api/...` only).
- Unprotected: `/api/vendor/location` open write; admin/dev rely solely on env flag with no auth; root/health unspecified.
- Health check: missing; add a `/health` returning 200 and dependency status.
- REST maturity: Level 2 (resources + verbs but custom actions like `/find-vendor`, `/accepted`).
- Naming consistency: Mostly snake in DB vs camel in API; mixed legacy fields accepted.
- Resource modeling: pickups primary; vendor callbacks procedural not resource-based.

### Phase 3 — Security Audit
- **Auth:** Customer endpoints depend on Supabase JWT; no refresh/rotation handling server-side. Vendor callbacks use HMAC with raw body; rejection/accept flows enforce assignment + expiry. Admin/dev routes lack user authentication.
- **Token handling:** Bearer tokens pulled from Authorization header, not validated locally; relies on Supabase. Service role key used server-side (high privilege) across vendor/admin flows.
- **Password hashing:** Delegated to Supabase Auth. No local handling.
- **RBAC:** None in Express; relies on Supabase RLS for customers. Vendors controlled by HMAC secret only; admins via env switch.
- **Input validation:** Manual checks; no schema sanitization; latitude/longitude parsing basic; potential null/NaN stored.
- **Injection risk:** Supabase query builder used; risk low. Local pg uses parameterized queries. No dynamic SQL from user input.
- **Rate limiting:** None; susceptible to brute-force/DOS.
- **CORS:** `cors()` default allows all origins & methods.
- **CSRF:** Not addressed; mostly bearer/HMAC API so low but admin/env bypass could be CSRFable.
- **Helmet/security headers:** None.
- **File uploads:** None.
- **Env exposure:** Requires service role key and anon key in server env; if leaked, privilege escalation. No config validation except required Supabase keys.
- **Secrets management:** Plain env vars; no rotation guidance; `VENDOR_API_TOKEN` optional outbound header.

**Security Hardening Score:** 38 / 100 — higher is better (0 = critically exposed, 100 = fully hardened). See *Scoring methodology* for weights, category ratings, and rounding. A score of 38 indicates weak posture consistent with the MVP gaps noted.
- **Critical:** Admin and dev endpoints lack authentication (env toggle only); vendor location endpoint unauthenticated but writes vendor metadata; in-memory dispatcher state loss may incorrectly accept late callbacks if DB not aligned; service-role usage on all vendor/admin calls increases blast radius if endpoint abused.
- **Medium:** No rate limiting/helmet; open CORS; HMAC secret required but missing dev bypass commented, so missing secret blocks vendor flows; no audit logging; fallback to in-memory store may expose stale data; `vendor/location` accepts localhost URLs in non-prod but only best-effort validation.
- **Hardening Roadmap (priority):**
  1. Add proper authentication/authorization for admin & dev endpoints (JWT role check or admin token).
  2. Protect `/api/vendor/location` with HMAC or vendor API token; enforce HTTPS/public URL validation consistently (even non-prod).
  3. Add rate limiting + helmet + strict CORS origin allowlist.
  4. Persist dispatcher state in a shared store (e.g., Redis/DB) to survive restarts and multi-instance deployments.
  5. Isolate service-role usage to internal jobs (no direct exposure to request handlers).
  6. Centralize validation (celebrate/joi/zod) and standardize error format.
  7. Add observability/audit logging for admin/vendor actions and rotate secrets regularly.

### Phase 4 — Database & Data Model Audit
- **Models (Supabase migrations):** `profiles` (id, role, contact), `pickups`, `pickup_items`, `scrap_types`, `scrap_rates`, `vendor_backends`, `pickup_vendor_rejections`; enums `pickup_status`. RPCs: `create_pickup`, `cancel_pickup`, `find_vendor_again`. RLS on key tables for authenticated users; service role bypasses.
- **Relationships:** `pickups.customer_id -> profiles.id`; `pickup_items.pickup_id -> pickups.id` and `scrap_type_id -> scrap_types.id`; `scrap_rates.scrap_type_id -> scrap_types.id`; `vendor_backends` loosely linked via text refs; `pickup_vendor_rejections` tracks vendor_ref per pickup.
- **Indexes:** Present on pickups (customer,status,vendor), pickup_items (pickup_id). No explicit index on `vendor_backends.vendor_id` but implied unique via onConflict; confirm constraint exists.
- **Integrity risks:**
  - Service-role updates bypass RLS.
  - Missing foreign key between vendor references and pickups.
  - `vendor_location` upsert accepts invalid URLs in non-prod.
  - In-memory dispatch state can desync from DB.
  - `create_pickup` assumes valid scrapTypeId; no FK checks in the RPC beyond casting.
  - Schema currently enforces uniqueness on `vendor_backends.vendor_ref` only; dispatcher also supports `vendor_id` paths without a unique constraint—add one if migrating to vendor_id.
- **Transactions:** Dispatcher updates atomic for offers/acceptances; RPC inserts items transactionally. Vendor rejection recording best-effort non-blocking.
- **Migration strategy:** SQL files in `supabase/migrations` but not orchestrated (manual apply). Optional local `db/client.js` creates similar schema.
- **Scalability:** 10x traffic limited by in-memory dispatcher and per-offer timers; no queue/caching. Supabase PostgREST can scale but service-role bottleneck and lack of indexes on vendor selection (full table scan to select vendors). Offer fanout sequential per pickup. Without background workers, single instance throughput is low (~hundreds rps max).

### Phase 5 — Performance & Scalability
- **Blocking ops:** Dispatcher fetches vendors/pickups synchronously; HTTP calls to vendor endpoints sequential per candidate with 10s timeout each (potentially slow). Express uses async/await; no CPU-heavy tasks.
- **N+1:** Pickup GET loads nested items in single query; minimal risk.
- **Unindexed queries:** vendor selection scans `vendor_backends` (no filters), acceptable small scale but not at scale.
- **Logging overhead:** Console logs verbose per dispatch; acceptable dev, noisy prod.
- **Caching/Queues:** None (no Redis/bull). Background timers in-memory only.
- **Retries:** Dispatch retries vendors sequentially; no exponential backoff; HTTP offer send throws on failure and advances.
- **Performance risk report:** Latency spikes when vendor endpoints slow; single-process timers limit parallelism; service-role Supabase client reused per call may hit rate limits; lack of graceful shutdown handling for timers.
- **Horizontal scaling readiness:** Poor—dispatch state is node-local; multiple instances will race/duplicate offers without shared store/lock.
- **Bottleneck forecast:** Vendor HTTP timeouts, service-role DB bottleneck, missing worker separation, and lack of persistence for dispatch state.

### Phase 6 — Code Quality & Engineering Practices
- **Layering:** Routes contain business logic; dispatcher centralizes dispatch logic; no dedicated service/repo layers.
- **Error handling:** Basic; some Supabase errors surfaced directly; internal errors return 500 with generic message.
- **Logging standards:** Console logs with structured-ish messages; no levels/ids; request logger minimal.
- **Tests:** None; no CI beyond agent workflow; migrations applied manually.
- **CI/CD:** No pipelines for lint/test/build; Render notes only.
- **Config duplication:** Mixed in-memory/local pg/Supabase paths; scrap type defaults appear in multiple places.
- **Dead code:** `routes/scrapTypes` not mounted; `data/store` and `db/client` unused in main flow.
- **Code Quality Score:** 45 / 100 — higher is better. See *Scoring methodology* for weights, category ratings, and rounding. A mid-40s score indicates MVP-level practices with notable gaps.

**Scoring methodology (both scores)**
- Security hardening weights: auth surface 40%, network exposure 25%, data protection 20%, operations 15%. Category ratings: 35/100, 40/100, 45/100, 35/100. Weighted sum = 38.25, rounded to nearest integer (38).
- Code quality weights: structure/abstractions 30%, testing/CI 25%, reliability/resilience 20%, documentation/config hygiene 15%, logging/observability 10%. Category ratings: 58/100, 32/100, 42/100, 48/100, 38/100. Weighted sum = 44.8, rounded to nearest integer (45).
- **Tech Debt (prioritized):**
  - Close auth gaps (admin/dev bypass, vendor location).
  - Persist/coordinate dispatch state.
  - Add tests and basic linting.
  - Extract config validation and remove duplicated defaults.
  - Remove or gate unused legacy paths (`routes/scrapTypes`, `data/store`, local pg).
  - Add structured logging and standardized error responses.

### Phase 7 — Product Backend Maturity Analysis
- Manual operational bias: dispatch relies on vendor backend callbacks; admin endpoints allow manual rate/type management but no auth.
- Automation readiness: Limited; no job queue or notifications; background timers only.
- Booking lifecycle: Supports request -> finding vendor -> assigned/on-the-way -> completed/cancelled; lacks payment/receipts.
- Dispatch logic: Present but single-process, distance-sorted, no capacity/availability modeling.
- Pricing engine: Simple active rate per scrap type; no multi-currency/discounts.
- Notifications: None (no SMS/email/push); relies on vendor endpoints for status changes.
- Product constraints: Single-region, no multi-tenant controls, fragile admin access, and no observability make regulated/production rollout risky.

### Phase 8 — Production Readiness
- **Go-to-prod?** Not without hardening. Current state is MVP/prototype.
- **Must fix before launch:** Auth for admin/dev/vendor-location; rate limiting + helmet + CORS allowlist; dispatcher persistence/shared store; secret management; CI with tests; clarify DB migration process; remove in-memory/local fallbacks in prod.
- **Will break under scale:** Multiple instances (duplicate offers), slow vendor endpoints (timer backlog), unbounded vendor list scans, lack of queues/retries, no monitoring.
- **Biggest architectural risk:** Stateless dispatch logic with in-memory state and service-role access; no coordination across instances.
- **Biggest operational risk:** Misconfigured env (missing secrets) or exposed service-role endpoints leading to unauthorized writes; absence of rate limiting/observability hampers incident response.

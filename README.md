# AdmitFlow

An implemented admissions-recovery application for coaching institutes: enquiries, a shared counsellor/AI inbox, recovery campaigns, counselling and receipt-backed revenue. The light workspace has **12 main screens**.

The selected stack is **Next.js 16.3.5 / React 19.3 / TypeScript / Node 24**, **Neon + Drizzle**, **WorkOS AuthKit**, **Cloudflare R2**, and **AWS ECS/Fargate**. Messaging uses **Meta WhatsApp Cloud API**, **OpenAI autonomous replies with human override**, and **ElevenLabs speech**. Existing WhatsApp Business app numbers use Meta's coexistence onboarding path.

**Production readback — 26 September 2026:** `https://admitflow.incfrog.ai/` is live, but its current `main` image opens the workspace shell at `/`; the public landing page is at `/welcome`. The landing entry fix is still pending in the working tree and has not been released. Read-only checks found the `AdmitFlow-prod` stack at `UPDATE_COMPLETE`, web and worker services running 1/1, a healthy web target, a public Route53 A alias to the ALB, and HTTPS `/api/health` and hosted `/api/ready` returning 200. The deployed image pair is tagged for `main` commit [`a8f7e5b`](https://github.com/Deepak8858/admitflow/commit/a8f7e5b7129e57a04bca4742323d44746c3c9d8a); its [main-push CI](https://github.com/Deepak8858/admitflow/actions/runs/36228138074) and [manual image publish](https://github.com/Deepak8858/admitflow/actions/runs/36228570291) completed successfully. The GitHub `BUILDS_APPROVED` variable was `false` at this readback, so another paid image publish requires renewed approval. These checks do not establish authenticated user journeys or provider acceptance. See [release gates](docs/release-gates.md) for release controls and [verification](docs/verification.md) for historical local results. The approved raw-intake policy remains 30 elapsed days from receipt, shortened to seven days after import when earlier.

## Local preview

From `H:\new-app`, with **Node 24**:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:3000**. With `DATABASE_URL` unset/empty, the app uses `.data/admitflow.sqlite`; `ADMITFLOW_DB` overrides that path. No environment file is needed for the default demo. If using `.env.local`, keep database/WorkOS/provider credentials empty for this preview and set `APP_BASE_URL=http://127.0.0.1:3000`.

The first unauthenticated local visit creates a cookie-scoped demo workspace. People, fees and messages are fictional; demo replies and incoming-message simulations use local knowledge and make no provider calls. SQLite preview is for one local Node instance, not shared multi-replica storage.

Try this workflow:

1. Add/import enquiries, review CSV errors and duplicates, then assign a counsellor.
2. Edit institute knowledge and choose **Autonomous**, **Co-pilot** or **Paused** in **AI & automations**.
3. In **Shared inbox**, use **Try an incoming message**. Use **Enable AI** on a human-owned thread to exercise demo autonomy; simulate a Business-app reply to exercise takeover. Simulation does not verify real coexistence.
4. Create a recovery campaign and use **Run due follow-ups** for due demo work.
5. Book counselling, record an admission receipt from enquiry details, and inspect revenue/refunds.

Settings also offers local evaluation registration/sign-in. Local team invitations do not send email or grant another account access. Hosted identity and real multi-user membership use WorkOS.

## Workspace screens

`/` Overview · `/leads` Enquiries · `/pipeline` Admissions pipeline · `/inbox` Shared inbox · `/appointments` Counselling · `/recovery` Recovery campaigns · `/automations` AI & automations · `/knowledge` Knowledge base · `/analytics` Revenue analytics · `/team` Team & access · `/integrations` Integrations · `/settings` Settings, including billing.

Navigation/actions follow owner, admin, counsellor and analyst permissions. **Ctrl/Cmd K** opens search; `?lead=<id>` opens the enquiry drawer. Hosted onboarding/institute switching is at `/onboarding`.

## Hosted configuration and commands

Setting `DATABASE_URL` selects PostgreSQL behavior; running a build alone does not select it. Hosted workspace access requires a verified WorkOS session and organization membership. Use [.env.example](.env.example) and the [deployment runbook](docs/deployment.md) for the complete configuration:

| Area | Main inputs |
| --- | --- |
| Origin/database | `APP_BASE_URL`, pooled `DATABASE_URL`, direct `DATABASE_URL_UNPOOLED` for migrations |
| WorkOS | `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`, `NEXT_PUBLIC_WORKOS_REDIRECT_URI` (`<origin>/callback`) |
| Worker | `REDIS_URL`; ECS constructs it from separately injected private Valkey credentials |
| Files/encryption | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, AWS `KMS_KEY_ID` |
| Messaging | Public `NEXT_PUBLIC_META_APP_ID` / `NEXT_PUBLIC_META_CONFIG_ID`, server `META_APP_SECRET` / `META_WEBHOOK_VERIFY_TOKEN`; optional platform `OPENAI_API_KEY`, `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` |

Meta's public IDs and the WorkOS redirect URI must match the **web build-time** configuration. Institute credentials and phone/Page/calendar/merchant mappings are managed through Integrations. OpenAI model, reply mode and daily limit are institute settings, not `OPENAI_MODEL`. Google OAuth, Meta Lead Ads and separate `BILLING_RAZORPAY_*` subscription configuration are detailed in [connected services](docs/connected-services.md).

After configuring the intended database and accounts:

```sh
npm run db:migrate -- --dry-run  # validates the journal locally
npm run db:migrate              # applies through DATABASE_URL_UNPOOLED
npm run worker                 # requires runtime DATABASE_URL + REDIS_URL
```

The continuous worker executes durable jobs. Optional bearer-authenticated `POST /api/jobs` uses `CRON_SECRET` to enqueue work; it is not a replacement worker. `INTEGRATION_WORKSPACE_ID` and the former Twilio configuration are superseded.

```sh
npm run db:import-sqlite -- --source .data/admitflow.sqlite
npm run build:services
```

SQLite import defaults to **backup + dry run**; applying requires explicit, verified WorkOS mappings. See the runbook before cutover. Docker packages Next standalone (`node server.js`) and the bundled worker (`node dist/worker.mjs`); [AWS deployment](docs/deployment.md) covers images, TLS, secrets, migrations and rollback. Release operators must verify current credentials, DNS, provider setup and cloud resources before changes.

## Checks and current limits

```sh
npm run verify:payments  # payment regressions and project typecheck
node scripts/verify.mjs --access # access/connected-service regressions and project typecheck
npm run verify          # application/infra tests, typechecks, builds, migration dry run
npm run verify:browser  # browser fixtures using disposable SQLite; check port 3100 first
```

The verifier removes inherited provider settings, blanks variables named in `.env.example`, uses in-memory application fixtures and a temporary browser database, and does not modify `.env.local` or preview SQLite. It is not a network sandbox. `node scripts/verify.mjs --build` resumes infra typechecking/build/bundle/migration stages without repeating tests. No lint script is configured.

On 22 September, **45 browser tests passed locally**, including the two authentication release regressions and existing workspace coverage. See [historical release evidence and limits](docs/release-gates.md#completed-evidence--do-not-repeat-provisioning). That run and earlier corrected test-harness failures are historical evidence; no test result for the pending landing entry fix is asserted here.

- `/api/leads` is paginated, but the shell and many mutations still load the full authorized workspace. Large-institute throughput needs targeted projections and load testing.
- Google synchronization is **AdmitFlow → Google only**, using one institute calendar. Availability checks are snapshots, not cross-system reservations.
- SaaS checkout/status/webhooks/immediate cancellation, verified invoice reads and member/enquiry quotas are implemented. Paid actions enforce a one-time 168-hour organization trial or freshly verified active coverage bounded by the billing-period end. Restrictions cover outbound/AI work, new enquiries and team invitation/reactivation; existing-data and safety work remain available. Signed inbound enquiries can be held for explicit import without automation after access returns. Cycle-end cancellation, upgrades/proration and SaaS refunds remain roadmap work.
- Admissions charts and headlines now share distinct-student reporting, exact paise totals and refund-date cash flow. Saved enquiry views persist `view`/`sort` server-side through migration `0005_saved_view_preferences`.
- Admission-payment recovery and access-concurrency repairs pass local/mock-provider regressions. Hosted webhooks enqueue durable receipts; the worker reconciles payment state. Team writes use tenant-scoped durable gates and positive-evidence recovery, never automatic replay of uncertain writes. See [payment recovery](docs/deployment.md#admission-payment-recovery) and [team access recovery](docs/deployment.md#team-access-recovery). Live merchant and multi-replica WorkOS validation remain staging gates.
- Actual Business-app coexistence, signed live delivery, provider scopes, speech and vector-enabled PostgreSQL still require configured-environment checks. R2 CORS/provider probes and disposable Neon recovery checks passed; application tenant authorization and populated, scrubbed cross-provider recovery remain separate gates.

## Handoff and detailed runbooks

- [Resume checkpoint](CHECKPOINT.md) and [implemented architecture / remaining scope](docs/production-plan.md)
- [Backend contracts, verification and projection limits](docs/backend-verification.md)
- [Connected services](docs/connected-services.md) and [deployment / migration / dependency audit](docs/deployment.md)
- [Current verification status](docs/verification.md)
- [Accepted UI direction — existing eight references](docs/production-ui-direction.md)
- [Resolved WhatsApp decision and coexistence path](docs/whatsapp-provider-review.md)

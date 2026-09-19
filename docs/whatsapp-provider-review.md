# AdmitFlow — resolved WhatsApp decision and coexistence handoff

Updated 12 September 2026. **Decision resolved and adapter implemented: Meta WhatsApp Cloud API + OpenAI autonomous replies + ElevenLabs speech.** Actual provider accounts, the existing Business-app number's eligibility and live coexistence/delivery have not been validated.

## Selected responsibilities

| Component | Role in the current implementation |
| --- | --- |
| Meta WhatsApp Cloud API | Per-institute WhatsApp transport, approved templates, replies/media, incoming messages, signed status callbacks and Business-app message echoes |
| AdmitFlow | Tenant routing, shared inbox/history, stable ownership, campaigns/jobs, guard checks, human takeover, retry/reconciliation and provider-outcome presentation |
| OpenAI | Institute-grounded autonomous replies, qualification and controlled counselling proposals; assisted and paused modes also available |
| ElevenLabs | Incoming voice-note transcription and optional synthesized voice replies within AdmitFlow's messaging flow |

The user approved **autonomous mode**, not only human-reviewed drafts. The code retains conversation-level human override, contact/guardian/window checks, institute configuration and bounded daily AI work. **Native ElevenLabs Agents WhatsApp is not the selected transport**; it is not needed to deploy an AdmitFlow speech-enabled inbox.

## Existing WhatsApp Business app number

The requested path is to keep the institute's existing Business-app number through **Meta coexistence onboarding**, subject to Meta's actual account/number eligibility and app configuration.

Implemented flow:

1. An owner/admin opens Integrations → WhatsApp Business and selects **“I already use the WhatsApp Business app.”** The component uses the configured Meta Embedded Signup ID and requests `featureType: "whatsapp_business_app_onboarding"` with session-info version 3.
2. The browser accepts signup results from the supported Facebook origins and handles both the normal finish and Business-app onboarding finish events. It combines the authorization code with the WABA and phone-number IDs before calling `whatsapp.exchange`.
3. The server exchanges the code, verifies the authorized number's WABA ownership, subscribes the app and saves a tenant-encrypted connection. Existing Cloud API credentials can also be verified through the manual form. A successful setup records configuration/account verification; a requested coexistence flag alone is not proof of coexistence.
4. Configure the public signed webhook at `<APP_BASE_URL>/api/webhooks/whatsapp`, including the applicable `messages` and `smb_message_echoes` subscriptions. Routing resolves the saved phone-number connection, not a browser-supplied workspace.
5. A **signed Business-app message echo** is recorded as an observed manual send. It transfers that thread to human ownership/pauses AI and can set `metadata.coexistence = "verified"` with `coexistenceVerifiedAt`. Client metadata and demo simulation cannot set that verified state.
6. The Integrations UI distinguishes requested coexistence from observed verification. The real phone-app send, webhook arrival, Cloud API reply, template delivery and takeover behavior still need to be exercised with the intended account.

An observed signed echo verifies that event path; it does not certify historical chat import, every account capability or WhatsApp calling. Those are not delivered features of this adapter. Do not present a successful button click, phone label or connection row as live coexistence evidence.

## Controlled autonomous behavior

- Institute settings select the model, language, knowledge/instructions, daily message limit, mode and voice options. A tenant OpenAI key or platform fallback can be used. The model is not read from the former `OPENAI_MODEL` environment variable.
- Eligible incoming turns create durable AI reply work. Older/duplicate turns do not become a new latest turn; opt-outs still stop automation. The code rechecks human ownership, latest turn, contact/guardian/window rules, AI mode/budget, assignment, campaign and connection/claim identity before dispatch.
- Counsellors can choose **Take over**, send a manual reply, or reply from the coexisting phone app. These paths pause AI for the conversation. The UI exposes **Enable AI** when the team deliberately returns it to the assistant.
- Booking proposals become an `appointment.book` job that performs the same live availability preflight as manual booking. A local booking and its pending Google sync are distinct outcomes. A proposal does not authorize the model to claim a confirmed external booking.
- Daily limits reserve in-flight work, but complete token/cost metering and model-quality evaluation are still further work. The prompts/retrieval/guards are implemented; live English/Hindi answer quality has not been established by mocked tests.

## Acceptance, delivery and safe recovery

The application distinguishes `queued`, provider `accepted`, callback-confirmed `sent` / `delivered` / `read`, `failed`, `reconcile` and explicit `demo` outcomes. A successful Meta message POST establishes acceptance, not delivery. Signed callbacks may arrive first, and later responses cannot downgrade verified delivery.

Stable request/message IDs and a durable dispatch marker are recorded before the message request. Callback/provider IDs deduplicate records. A timeout after dispatch enters reconciliation and cannot be converted into another send by supplying a new manual “confirmed not sent” flag. Safe undispatched failures and idempotent service work have bounded retries; stale claims are fenced during recovery. Missing authoritative status can leave a send unresolved indefinitely.

Recovery campaigns use an approved Meta template and recorded outreach eligibility; a form submission or free-form reply does not grant future campaign opt-in. The current template adapter supports body fields `name`, `course`, `institute` / positions `1–3`. Rich header-media and dynamic-button parameter workflows are not implemented.

## Speech path

Incoming audio is fetched through the authenticated Meta media path with host/redirect/size/content checks, then transcribed by ElevenLabs. With a usable voice and the institute's voice-reply option, generated audio is stored privately in R2, uploaded to Meta and sent through the same guarded messaging operation. The transcript/generated text remains available to the inbox.

Pre-dispatch transcription, synthesis, R2 or media-upload failure can produce a text fallback with `Message.voiceFallback`. Ambiguous acceptance after the WhatsApp message request cannot cause a second text send. These paths have mocked provider tests; real voices, media behavior, latency and usage costs still need a credentialed run.

## Configuration and local exercise

Hosted operation uses the existing Neon/WorkOS organization model and KMS-encrypted institute connections. Start from [.env.example](../.env.example) and [deployment](deployment.md).

| Purpose | Configuration |
| --- | --- |
| Application/identity | `APP_BASE_URL`, `DATABASE_URL`, WorkOS/AuthKit variables and supported roles |
| Meta browser onboarding | `NEXT_PUBLIC_META_APP_ID`, `NEXT_PUBLIC_META_CONFIG_ID`; supply matching values at web build time |
| Meta server/webhook | `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, optional `META_API_VERSION`; `META_APP_ID`, if used for Page verification, matches the public app ID |
| WhatsApp institute mapping | Access token, WABA ID and phone-number ID in the encrypted institute connection |
| OpenAI | Institute key or `OPENAI_API_KEY`; model/mode/limits in AI settings |
| ElevenLabs | Institute key/voice or `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`; enable the relevant voice option |
| Private audio/files | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` and tenant KMS configuration |
| Continuous execution | `npm run worker` with runtime `DATABASE_URL` and `REDIS_URL`; optional `CRON_SECRET` endpoint enqueues work |

The old platform-wide Twilio sender and `INTEGRATION_WORKSPACE_ID` model are superseded. Each institute resolves through its stored connection and server-maintained routing identifiers.

For a credential-free preview, leave `DATABASE_URL` unset and run `npm run dev`. In the demo inbox, **Try an incoming message** exercises autonomous local knowledge replies; the Business-app echo checkbox exercises human takeover. Demo paths are tested with provider/KMS/R2 calls prohibited. A demo echo does not verify a real number. Current redesigned-browser QA remains pending with the parent.

## Evidence and remaining provider checks

The [backend verification record](backend-verification.md) covers signed tenant routing, echoes, duplicate/out-of-order callbacks, acceptance races, guarded dispatch, restart/retry behavior, mock speech/media and provider-free demos. Those cases contribute to the current **94 passing backend/service tests**; they do not establish live account connectivity.

A configured pilot must still verify the actual existing number's eligibility, coexistence-enabled Meta config/app permissions, approved templates, both phone-app and Cloud API sends, signed callback delivery, human/AI ownership changes, the selected OpenAI model and ElevenLabs voice, and private R2 media behavior. Actual account review, throughput/limits, fees and provider quality are external deployment inputs, not capabilities certified by this handoff.

## Earlier native ElevenLabs review — historical decision context

The prior documentation review established that ElevenLabs offers native agent-led WhatsApp text, voice notes, templates, media and calls, and can use OpenAI models. It also recorded these constraints in that native flow:

| Earlier documentation finding | Why it mattered to this decision |
| --- | --- |
| Human handoff was documented as coming soon | AdmitFlow needed application-owned counsellor takeover immediately |
| Standard import restricted numbers already active in the Business app or another provider | The user's existing-number requirement needed a separately verified coexistence path |
| Template acceptance did not mean delivery; batching remained per recipient | AdmitFlow still needed its own job/outcome tracking |
| Click-to-WhatsApp referral metadata was not exposed to native agent context | That integration did not establish the requested attribution behavior; Meta Lead Ads form intake is a separate implemented service |

These are retained observations from the earlier review, not a fresh provider-capability check and not a reopening of the selected Meta transport.

Earlier documentation sources:

1. [ElevenLabs native WhatsApp overview](https://elevenlabs.io/docs/eleven-agents/whatsapp)
2. [Native WhatsApp getting started](https://elevenlabs.io/docs/eleven-agents/whatsapp/getting-started)
3. [Outbound messages and templates](https://elevenlabs.io/docs/eleven-agents/whatsapp/outbound)
4. [Troubleshooting and FAQ](https://elevenlabs.io/docs/eleven-agents/whatsapp/troubleshooting#faq)
5. [Native agent model support](https://elevenlabs.io/docs/eleven-agents/customization/llm)

Current implementation details take precedence for AdmitFlow behavior: `whatsapp-connect.tsx`, `providers/meta.ts`, `providers/ai.ts`, `providers/speech.ts`, `integrations.ts` and the linked backend/deployment runbooks. No real WhatsApp number was provisioned or message sent as part of this documentation handoff.

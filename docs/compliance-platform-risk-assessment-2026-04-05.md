# Compliance and Platform Risk Assessment

Date: 2026-04-05

## Purpose

This document combines:

- the external compliance playbook in `/Users/suhail/Downloads/deep-research-report (1).md`
- the OpenClaw / WhatsApp enforcement analysis in `/Users/suhail/Downloads/deep-research-report (2).md`
- a code-level review of the current `WA-copilot` repository

The goal is to answer three questions:

1. What do the two reports actually say when read together?
2. How does the current product implementation compare to those recommendations?
3. What should we do next if we want a defensible product posture for EU and Gulf markets?

## Executive Conclusion

The two reports are consistent with each other.

The first report says the main risks are:

- WhatsApp platform enforcement
- data protection compliance
- trust posture and procurement readiness

The second report explains why competitors like OpenClaw can still exist without disproving those risks:

- enforcement appears to be mostly account-level, not project-level
- detection is behavior-sensitive and probabilistic
- low-volume or low-complaint usage can persist
- unofficial WhatsApp Web automation remains in a policy-risk zone even when it still "works"

Taken together, the right conclusion is:

- unofficial WhatsApp Web automation can remain operational for some users
- that does not make it compliant, low-risk, or suitable as the primary foundation for a compliance-forward product

For this repository, the current implementation is materially closer to "automated WhatsApp responder over an unofficial channel" than to the safer "draft-first, human-in-the-loop, local-first with explicit consent" posture recommended by the compliance playbook.

## Final Position

If the product is intended for regulated, premium, or procurement-sensitive customers in the EU and Gulf:

- the official WhatsApp Business Platform should be the primary path for any automated sending
- WhatsApp Web support should be treated as experimental or personal-use only
- draft-only / manual-send should be the default mode for any unofficial WhatsApp integration

If we keep the current architecture and defaults, we should assume:

- elevated account-ban risk
- weak enterprise defensibility
- a gap between product claims and implementation reality

## Source Synthesis

### Report 1: Main points

The first report argues that the product will be judged mainly on:

- whether it violates or appears to violate WhatsApp terms
- whether privacy claims are true in architecture and practice
- whether the product ships with trust controls and documentation

Its core product recommendation is:

- default to draft-only or assistive behavior
- keep auto-reply behind explicit risk gates
- minimize telemetry
- document processors, retention, consent, and cross-border handling
- create a trust and compliance pack

### Report 2: Main points

The second report argues that OpenClaw is not "immune" from enforcement. Instead:

- WhatsApp likely enforces against accounts and behaviors rather than against the open-source project itself
- unofficial WhatsApp Web tools can remain available even while connected accounts get restricted
- reconnect loops, suspicious automation patterns, and uncontrolled outbound messaging are meaningful enforcement triggers
- the absence of a public takedown is not evidence of compliance

Its practical recommendation is:

- prefer the official Business Platform for automation
- if WhatsApp Web is supported, keep it narrow, conservative, and clearly risk-labeled

### Combined interpretation

The reports do not conflict.

Report 2 does not reduce the compliance burden identified in Report 1. It explains why the market contains risky tools that still remain accessible.

The most defensible interpretation is:

- "available" is not the same thing as "safe"
- "works today" is not the same thing as "marketable to risk-sensitive buyers"
- "not publicly banned" is not the same thing as "compatible with EU/Gulf trust expectations"

## Current Product Assessment

## 1. WhatsApp Platform Risk

### Current behavior

The current implementation sends WhatsApp messages automatically.

Evidence:

- final AI replies are automatically delivered in `src/renderer/src/lib/whatsapp-integration.ts:161`
- the main agent flow triggers outbound WhatsApp delivery in `src/renderer/src/hooks/useAgent.ts:376`
- courtesy delay notifications are auto-sent in `src/renderer/src/hooks/useAgent.ts:355`
- admin escalation notices are auto-sent in `src/renderer/src/hooks/useAgent.ts:393`
- handshake verification messages are auto-sent in `src/main/whatsapp/WhatsAppService.ts:592`
- admin relay forwarding sends the admin reply back to the customer automatically in `src/main/whatsapp/WhatsAppService.ts:500`

### What is already helping

There are real anti-ban controls:

- hourly message throttle in `src/main/whatsapp/WhatsAppService.ts:842`
- humanized delay in `src/main/whatsapp/WhatsAppService.ts:826`
- reconnect backoff in `src/main/whatsapp/WhatsAppService.ts:874`
- optional sleep mode in `src/main/whatsapp/WhatsAppService.ts:910`
- message deduplication in `src/main/whatsapp/WhatsAppService.ts:855`

These controls reduce behavior risk, but they do not change the fact that the product is still acting as an automated unofficial WhatsApp client.

### Gap versus the reports

The compliance-safe default recommended by the combined evidence is:

- draft-only by default
- human approval before send
- inbound-only by default
- explicit risk gating for auto-reply

The current product does not meet that bar.

### Assessment

Risk level: High

Reason:

- the current product behavior matches the exact category the reports treat as the primary platform risk

## 2. Privacy and Data Flow Risk

### Current behavior

The product stores substantial local message data.

Evidence:

- raw WhatsApp messages are stored in SQLite in `src/main/whatsapp/ChatLoggingService.ts:21`
- session histories are stored in SQLite in `src/main/services/ChatPersistenceService.ts:24`
- session mirrors are written to JSON and Markdown files in `src/main/services/SessionMirrorService.ts:33`
- mirrored Markdown files include message content and thought blocks in `src/main/services/SessionMirrorService.ts:53`

### Cloud and outbound data reality

The product is not purely local-only in its current implementation.

Evidence:

- cloud LLMs are enabled in `src/renderer/src/lib/constants.ts:2`
- OpenAI-compatible requests are sent in `src/renderer/src/lib/llm/openai.ts:343`
- Gemini cloud calls exist in `src/main/packages/rag-engine/index.ts:95`
- Firebase is initialized in `src/renderer/src/lib/firebase/init.ts:63`
- Firestore sync exists in `src/renderer/src/lib/firebase/db.ts:17`
- user settings are synced to cloud in `src/renderer/src/hooks/useSettingsSync.ts:45`
- IP geolocation is requested from `get.geojs.io` in `src/renderer/src/lib/user-environment.ts:4`

### What is already helping

- API keys are intentionally excluded from Firestore sync in `src/renderer/src/hooks/useSettingsSync.ts:63`
- memory entities have PII and secret checks before storage in `src/main/services/MemoryService.ts:393`

### Gaps versus the reports

The reports require clarity on:

- what data stays local
- what data leaves the device
- which processors receive it
- whether consent is required before cloud features activate
- how retention and deletion work

Current gaps:

- no clear cloud-processing consent gate was found
- no clear user-facing processor disclosure was found
- no retention policy implementation was found
- no complete export/delete workflow was found
- README and UI language overstate the "local-only" story

### Assessment

Risk level: High

Reason:

- the product claims privacy-first and local-first behavior, but the actual data flow story is mixed and insufficiently disclosed

## 3. Security and Secrets Handling

### Current behavior

Secret storage is one of the stronger areas of the codebase.

Evidence:

- sensitive keys are blocked from the regular Electron store in `src/main/ipc/store.ts:15`
- allowed secrets go through secure storage in `src/main/ipc/secure.ts:32`
- encrypted secure-store retrieval is used from settings in `src/renderer/src/stores/settingsStore.ts:208`

### Important limitation

If OS-level encryption is unavailable, the secure storage layer falls back to plaintext storage.

Evidence:

- fallback behavior appears in `src/main/ipc/secure.ts:46`

This may be operationally convenient, but it is not a strong posture for high-trust or regulated markets.

### Assessment

Risk level: Medium

Reason:

- good direction overall
- fallback behavior and missing hard policy controls keep it from being enterprise-ready

## 4. Logging and Telemetry Risk

### Current behavior

The code logs sensitive content too freely.

Evidence:

- incoming message previews are logged in `src/main/whatsapp/WhatsAppService.ts:429`
- outgoing message content previews are logged in `src/main/whatsapp/WhatsAppService.ts:719`
- intelligence logs store descriptive details in `src/main/services/IntelligenceService.ts:42`
- document ingestion events log filenames and failure details in `src/main/packages/rag-engine/index.ts:91`

There is also session-level logging infrastructure:

- append-only log writing in `src/main/ipc/logs.ts:15`

### Telemetry reality

I did not find active product analytics event usage beyond Firebase Analytics initialization, but:

- analytics initialization exists in `src/renderer/src/lib/firebase/init.ts:116`
- the codebase does not appear to expose a clear user-facing telemetry consent flow

### Gap versus the reports

The reports recommend:

- no message content in telemetry
- redacted structured logging
- short retention
- manual support export instead of silent remote upload

Current state does not meet that standard.

### Assessment

Risk level: High

Reason:

- local logging currently includes content that should be redacted or removed by default

## 5. Compliance UX and Trust Materials

### Current behavior

The repository contains product claims and some implied safety language, but I did not find a complete trust layer.

Evidence:

- README claims "No cloud" and strong privacy positioning in `README.md:10` and `README.md:38`
- the About panel repeats privacy-first positioning in `src/renderer/src/components/SettingsPanel.tsx:473`
- README mentions a risk disclaimer and ToS warning as requirements in `README.md:82` and `README.md:98`

### Gap versus the reports

I did not find complete implementations for:

- Privacy Policy
- Terms of Service
- Responsible Use Policy
- Security page
- DPA or subprocessor list
- cookie consent or analytics consent
- WhatsApp risk onboarding gate
- customer opt-in / opt-out records
- blocked-contact list or opt-out enforcement

### Assessment

Risk level: High

Reason:

- enterprise and premium-market trust requirements are largely still missing

## Where We Match the Reports

These are the parts where the current codebase already points in the right direction:

- local storage is real and substantial
- secret handling is better than average for an early-stage desktop product
- there are anti-ban behaviors rather than reckless high-volume sending
- some privacy-aware memory filtering exists
- Firestore sync avoids syncing API keys by default

This means the product is not starting from zero. It already has a useful privacy and risk-mitigation base.

## Where We Clearly Do Not Match the Reports

These are the highest-confidence misalignments:

- auto-send is a core behavior, not a gated exception
- privacy-first messaging is broader than the implementation supports
- cloud LLM and Firebase pathways are enabled without a corresponding consent and disclosure layer
- logs and mirrored files contain more sensitive content than a compliance-forward design should allow
- there is no full trust/compliance documentation pack
- there is no customer-facing opt-in / opt-out enforcement model

## Strategic Options

## Option A: Stay on the current path

Description:

- continue using unofficial WhatsApp Web automation as the primary product path
- keep current auto-send behavior
- improve anti-ban and stability controls incrementally

Pros:

- fastest path to preserve current product behavior
- aligned with the current architecture

Cons:

- weakest compliance and procurement story
- hardest to defend in EU/Gulf premium markets
- continued platform-ban risk
- continued mismatch between marketing and implementation

Recommendation:

- not recommended if the goal is trust-sensitive GTM

## Option B: Hybrid model

Description:

- official WhatsApp Business Platform becomes the primary automation channel
- unofficial WhatsApp Web mode remains available as experimental or personal-use mode
- WhatsApp Web mode defaults to draft-only / manual-send

Pros:

- strongest balance between product continuity and defensibility
- preserves experimental flexibility
- aligns best with both reports

Cons:

- requires product and architecture branching
- requires messaging discipline

Recommendation:

- recommended

## Option C: Full compliance-first repositioning

Description:

- stop supporting unofficial WhatsApp sending entirely
- move all automation to official channels only

Pros:

- cleanest compliance story
- easiest trust narrative

Cons:

- may eliminate part of the current product differentiation
- may reduce appeal for users who want to avoid official APIs

Recommendation:

- viable if the business decides enterprise trust is more important than unofficial-channel convenience

## Recommended Decision

Option B is the best fit.

That means:

- official Business Platform for real automation and customer-facing go-to-market
- WhatsApp Web mode retained only as experimental / personal-use / unsupported-for-enterprise
- default product posture becomes draft-first and consent-forward

## Action Plan

## P0: Stop the biggest mismatches

1. Change WhatsApp Web mode to draft-only by default.
2. Add an explicit warning gate before enabling auto-send.
3. Remove message-body logging from console and internal logs.
4. Add a clear "local-first with optional cloud providers" disclosure in the product.
5. Add an explicit consent gate before any cloud LLM processing.

## P1: Build the compliance backbone

1. Add opt-out and blocked-contact enforcement.
2. Add inbound-only default behavior.
3. Add retention settings for chats, mirrors, and logs.
4. Add export and delete workflows for local data.
5. Add a manual support-export bundle instead of passive broad logging.

## P2: Build the trust pack

1. Privacy Policy
2. Terms of Service
3. Responsible Use Policy
4. Security page
5. DPA and subprocessor list
6. DPIA-lite template for internal and customer use

## Product Messaging Changes Required

Current language such as:

- "No cloud"
- "local-only"
- "privacy-first"

should only be used if they are true by default and true in practice.

Given the current codebase, more accurate wording would be:

- "local-first desktop agent"
- "messages are stored on-device by default"
- "optional cloud AI providers can be enabled by the user"
- "secrets remain local"

Until the product is changed, the existing stronger language should be treated as a trust risk.

## Educated Bottom-Line Conclusion

OpenClaw-style availability is not evidence that the product category is safe. It is evidence that WhatsApp enforcement is selective, behavior-based, and often targeted at accounts rather than at the software distribution layer.

For `WA-copilot`, the main problem is not that the codebase has no privacy or safety work. It does.

The real issue is that:

- current defaults are too automation-heavy
- current logging is too permissive
- current marketing overclaims privacy/locality
- current trust/compliance packaging is incomplete

The most defensible path is not to pretend the current architecture is compliant enough. The most defensible path is to narrow the claims, change the defaults, and separate experimental WhatsApp Web support from the official/commercial automation strategy.

## Short Decision Statement

Use this statement internally:

"Our current WhatsApp Web architecture may remain technically usable for some users, but it should not be treated as a compliance-safe primary product path. For EU/Gulf trust-sensitive markets, we should lead with official WhatsApp Business integrations and position any WhatsApp Web automation as experimental, draft-first, and explicitly higher risk."

## Why This Is Also an Opportunity

The same facts that make this a risk can also make it a strong business opportunity.

Most products in this category are trying to win on:

- more automation
- faster auto-replies
- more aggressive WhatsApp workflows
- "works without the official API"

That creates a crowded and fragile market position.

If many competitors are optimizing for maximum automation, then they are all competing inside the same risk zone:

- platform enforcement risk
- weak trust posture
- poor procurement readiness
- hard-to-defend privacy claims

This gives us a chance to deliberately move in a different direction.

## The Core Opportunity

Instead of competing as:

- a WhatsApp auto-responder
- an unofficial WhatsApp automation tool
- a bulk-style AI messaging product

we can compete as:

- a trust-first customer conversation copilot
- a local-first support assistant
- a compliance-aware inbox operating system
- a safer bridge from chaotic personal messaging to structured customer operations

That is a meaningfully different category position.

## Why This Position Can Win

### 1. Most competitors optimize for raw automation, not trust

The reports suggest that many unofficial tools can remain technically usable while still operating in a policy-risk zone.

That means the market may contain many products that:

- work for now
- are attractive to growth-hungry users
- are difficult to justify to serious or risk-sensitive buyers

This creates room for a product that says:

- "we are not trying to maximize risky automation"
- "we are trying to make customer communication safer, more controllable, and more reliable"

### 2. Risk-sensitive customers are underserved

Many small and mid-sized businesses want automation help, but they do not actually want:

- uncontrolled sending
- spam-like behavior
- unclear data handling
- vendor answers that sound aggressive or evasive about platform risk

In trust-sensitive markets, especially EU and Gulf segments, a safer posture can become a buying reason rather than a limitation.

This is especially true for:

- clinics and healthcare-adjacent businesses
- legal and financial advisors
- premium local service businesses
- founders and operators who care about data control
- teams that want AI help without surrendering final approval

### 3. "Draft-first" can be sold as a premium feature, not a compromise

A common mistake would be to treat manual approval as a product weakness.

It can instead be positioned as:

- brand protection
- error prevention
- customer trust preservation
- safer delegation

For many serious operators, "AI drafts, human approves" is easier to adopt than "AI sends automatically."

### 4. We can own the migration path

There is a real product opportunity in helping users move from:

- personal WhatsApp chaos
- copy-paste customer support
- undocumented team replies
- ad hoc knowledge handling

into:

- structured conversations
- suggested replies
- escalation workflows
- searchable knowledge
- daily summaries
- compliant automation over time

This means the product does not have to be "all automation now."

It can be:

- step one: assist
- step two: organize
- step three: control
- step four: automate safely through official channels

That is a much stronger long-term product arc.

### 5. Compliance can become a visible product surface

Most products treat compliance as background legal text.

We can turn it into user-visible features:

- send approval
- contact-level opt-out and block controls
- retention settings
- export and deletion tools
- cloud-processing consent toggles
- local-only mode
- processor disclosures
- audit trail of AI-generated drafts and approved sends

Once these are visible product features, they stop being abstract compliance costs and become reasons to choose the product.

## Product Positioning Opportunity

The strongest positioning is likely not:

- "best WhatsApp automation tool"

The stronger positioning is closer to:

- "local-first customer conversation copilot"
- "AI-assisted support desk for WhatsApp and email"
- "trust-first inbox assistant for small businesses"
- "customer operations copilot with human approval and optional automation"

This matters because it changes the sales conversation.

Instead of having to defend:

- why unofficial automation is acceptable

we get to lead with:

- why control, auditability, privacy, and safer defaults matter

## Business Opportunity by Segment

### EU and Gulf premium/trust-sensitive SMBs

Opportunity:

- these buyers are more likely to value caution, clarity, and documentation
- they are less likely to be impressed by "growth hack" positioning

Why we can win:

- a safer posture is easier to justify internally
- privacy and control are closer to the buying criteria

### Local services and founder-led businesses

Opportunity:

- these users need help with customer response quality and speed
- many do not need full autonomous sending on day one

Why we can win:

- a draft assistant solves real pain with lower perceived risk

### Regulated or reputation-sensitive verticals

Opportunity:

- these users often cannot tolerate hallucinations, uncontrolled auto-send, or messy logs

Why we can win:

- they may accept less automation in exchange for more trust and control

## Strategic Reframe

The reframe is:

- do not try to be the boldest unofficial WhatsApp automation product
- try to be the safest, clearest, and most trustworthy customer communication assistant

That changes the moat.

Instead of competing on:

- "how much can we automate before we get caught"

we compete on:

- "how confidently can a business adopt AI into customer communication"

This is a better long-term business foundation.

## Practical Opportunity Statement

This can be discussed internally using the following framing:

"The compliance and platform constraints are not only a limitation. They create a market gap. Many products can promise more automation, but fewer can credibly offer safe defaults, local-first control, approval workflows, and an official path to compliant automation. If we build around that gap, the product becomes easier to trust, easier to justify, and more defensible in premium markets."

## Discussion Prompt

To reach a final decision as a team, the real strategic question is not:

- "Can we still make unofficial WhatsApp automation work?"

The better question is:

- "Do we want to win on maximum automation, or do we want to win on trust, control, and survivability?"

That is the decision this report should help drive.

## Pivot Impact

This is not a full product reset.

It is better understood as a change in the center of gravity of the plan.

### Original plan

The current blueprint in `README.md` is centered on:

- self-hosted desktop deployment
- personal WhatsApp connectivity
- AI that replies automatically
- local dashboard and summaries
- anti-ban measures to keep the unofficial channel usable

In simple terms, the original product promise is:

- "turn any personal WhatsApp number into a 24x7 AI support agent"

### Revised plan

The revised plan would keep most of the same assets, but change the product core from:

- unofficial WhatsApp auto-send as the main value

to:

- autonomous customer-support intelligence with safer delivery controls

In simple terms, the revised promise becomes:

- "give businesses an autonomous support brain with human approval where needed and full automation where defensible"

### What stays the same

The following major parts of the current plan still remain valuable:

- desktop and local-first architecture
- WhatsApp and email channel support
- RAG and business knowledge ingestion
- conversation summaries and dashboards
- escalation logic
- customer-service workflow assistance
- self-hosted value for smaller businesses

This matters because it means the product is not being discarded.

### What changes

The main change is that the definition of autonomy becomes narrower and more structured.

Instead of:

- AI automatically replying over unofficial WhatsApp by default

the product would move toward:

- AI autonomously understanding, drafting, triaging, escalating, documenting, and operating workflows
- AI sending automatically only in channels or scenarios that are operationally and commercially defensible

### Positive effects of the pivot

- stronger trust posture
- lower platform concentration risk
- easier enterprise and premium-market explanation
- less contradiction between implementation and marketing
- more durable long-term business foundation

### Negative effects of the pivot

- reduced short-term "wow" factor for users expecting instant full autonomous WhatsApp sending
- weaker appeal to users who specifically want aggressive unofficial automation
- additional product and engineering work
- possible perception that the product is becoming less bold

### Bottom-line impact

The pivot trades:

- some short-term flash

for:

- higher survivability
- clearer positioning
- stronger defensibility

That trade may feel painful emotionally because it touches the original magic of the idea, but it does not mean the original vision has to die.

It means the vision needs a more durable operating model.

## Autonomy Strategy

The right move is not to abandon autonomy.

The right move is to redefine autonomy so that it remains the core value proposition without forcing the whole company to rely on the riskiest possible implementation.

### The key distinction

There are two very different things that can both be called "autonomy":

- autonomous decision-making and workflow execution
- autonomous sending on unofficial WhatsApp infrastructure

The first can remain the heart of the product.

The second should not be allowed to define the whole company.

### What "full autonomy" should mean in this product

For this product, full autonomy should mean the system can autonomously:

- read and classify inbound customer messages
- search business knowledge and memory
- decide whether the answer is known or should be escalated
- prepare the best next action
- create a reply draft
- update internal notes, dashboards, or CRM-like state
- trigger reminders or follow-up workflows
- summarize activity and unresolved issues
- operate continuously with minimal human supervision

That is already a very strong form of autonomy.

### Where autonomy can remain strongest

Autonomy should be strongest in:

- inbox understanding
- task execution
- internal workflow orchestration
- support knowledge retrieval
- escalation logic
- summary generation
- official channels where automation is supported

This preserves the original "AI agent" ambition in a way that is easier to defend.

### Where autonomy should be gated

Autonomy should be more tightly gated in:

- unofficial WhatsApp Web outbound sends
- first contact to new recipients
- high-risk or high-sensitivity replies
- ambiguous answers without strong grounding
- scenarios involving sensitive customer data

This keeps the riskiest layer from becoming the single point of business failure.

### Suggested autonomy tiers

One clean way to preserve the original product vision is to define autonomy as a tiered system.

#### Tier 1: Copilot

Behavior:

- AI reads, reasons, drafts, and recommends
- human approves the final send

Value:

- easiest to trust
- lowest perceived risk
- strongest entry point for cautious customers

#### Tier 2: Guarded Autopilot

Behavior:

- AI can send automatically in low-risk, approved scenarios
- for example: known contacts, inbound-only replies, low-risk FAQs, or pre-approved flows

Value:

- preserves real automation
- creates strong user-perceived autonomy
- limits the riskiest behavior patterns

#### Tier 3: Full Official Autonomy

Behavior:

- AI sends autonomously through official channels such as the WhatsApp Business Platform and email where policies and controls are clearer

Value:

- strongest commercial version of autonomy
- easiest to sell to serious customers
- best long-term premium offering

### Product messaging impact

This allows the company to keep autonomy as the headline, but with a stronger definition.

Instead of saying:

- "AI fully autonomously replies on personal WhatsApp"

the product can say:

- "Autonomous customer support engine with approval controls"
- "AI runs support workflows end to end, with human approval where needed"
- "Start in copilot mode, graduate to autopilot"
- "Full official-channel autonomy for serious deployments"

This is still a strong ambition.

It is also much easier to defend.

### Why this matters emotionally and strategically

The painful part is that the original selling point was the boldness of full autonomous WhatsApp behavior.

That boldness is real, and it is part of what makes the idea exciting.

But if autonomy is defined too narrowly as:

- "unofficial WhatsApp auto-send at all costs"

then the company becomes trapped by the most fragile part of the stack.

If autonomy is redefined as:

- "AI-operated customer support with channel-aware control"

then the original dream survives in a stronger form.

### Recommended internal framing

Use this framing when discussing the product direction:

"We are not moving away from autonomy. We are moving away from a fragile definition of autonomy. The product should still feel highly autonomous to customers, but that autonomy should live in the intelligence layer, the workflow layer, and official send paths first, rather than depending entirely on risky unofficial outbound automation."

## Closing Reflection

The strategic issue is not whether the current fully autonomous unofficial WhatsApp plan is exciting.

It is exciting.

The strategic issue is whether that exact implementation should be the foundation of the company.

The combined evidence in this report suggests the answer is:

- autonomy should remain the vision
- unofficial WhatsApp auto-send should not remain the single defining pillar

That is the distinction that should guide the final decision.

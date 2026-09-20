# LLM provider and data-handling boundary

## Current autonomous worker

The unattended Electron main-process supervisor currently has one model path:

- `GOOGLE_API_KEY` creates the main-process `GeminiClient`.
- Decisions call Google's Generative Language API using the Gemini 2.0 Flash
  endpoint.
- If the key is absent, the supervisor does not silently fall back to another
  provider; model execution fails closed into escalation.
- Customer message text, scoped conversation context and retrieved business
  evidence may be sent to that provider. Local SQLite, RAG and memory stores
  remain on the owner machine unless another configured integration receives
  the data.

The renderer exposes WebLLM, Ollama, OpenAI-compatible, OpenRouter and Gemini
chat options for interactive use. Those options are not autonomous-worker
providers and must not be described as the unattended data path.

## Required approval before unattended production use

The deployment owner must record:

1. The approved provider and exact model.
2. The provider account/project and applicable processing region or residency
   statement.
3. Whether customer content may leave the owner machine.
4. Provider retention/training controls and the deletion procedure.
5. Allowed data classes, including whether attachments and sensitive topics are
   prohibited from model submission.
6. The spend limit and provider-account alert.

Until those decisions are recorded, keep the supervisor in observe-only or
draft mode. Local WebLLM availability does not satisfy this gate because the
autonomous worker does not currently route through it.

Auto-reply also requires `AICA_LLM_DATA_POLICY_APPROVED=true` (or `1`/`yes`)
in the owner-machine environment. This acknowledges that the provider,
region/residency, retention and allowed-data decisions above were reviewed;
it is not a claim that the provider has approved the use case.

Implementation references: `src/main/services/AutonomousSupervisor.ts`,
`src/main/packages/core/index.ts`, and `src/renderer/src/lib/llm.ts`.

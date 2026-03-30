# WA-copilot

```markdown
# AIConsumerAgent Self-Hosted – Complete Research + Implementation Blueprint  
**For AI Coding Agent (March 2026 Edition)**  

**Version:** 1.1 (Hardened Persistence & Relay)  
**Date:** 29 March 2026  
**Author:** Antigravity AI Agent  
**Target:** Self-hosted desktop software running 100% on the business owner’s Windows/Mac/Linux machine  
**Goal:** Turn any personal WhatsApp number into a 24×7 AI customer support agent + local dashboard + summaries. No cloud, no Meta API, no per-message fees.  

---

## 1. Executive Summary & Market Opportunity

### Original Market Gaps Identified (Tasks 1–4)
**Task 1 – Competitor Pain Points (Tidio, ManyChat, Wati):**  
- Ineffective AI (hallucinations on policies/returns)  
- Rigid WhatsApp API + 24h window + template approvals  
- Lack of human-like empathy in billing/escalation  

**Task 2 – Micro-Niches Underserved:**  
1. Boutique medical/dental clinics (HIPAA-lite + appointment + insurance)  
2. Local HVAC/plumbing/electrical (real-time dispatch + parts lookup)  
3. Salons/spas/restaurants (preference booking + inventory + loyalty)  

**Task 3 – Integration Nightmare:**  
Legacy CRMs (old Zoho, Excel, QuickBooks Desktop), old WooCommerce, Google Sheets → manual copy-paste burden.  

**Task 4 – Human-AI Hybrid Gap:**  
Perception vs reality: businesses think AI works, customers hate robotic handoffs.  

**Gap Scores (original):** 9–10/10 across all.  
**Self-hosted viability (March 2026 reality check):** 2.5/10 overall due to “always-on laptop” and ban risks, but still the ONLY architecture that gives full data sovereignty + zero fees for micro-SMEs who refuse official API.

**Product Positioning:**  
“The OpenClaw + Canva” for Indian local service businesses. Privacy-first, local-only, vertical-ready.

**Projected Use Case (India SMEs):**  
8–12 lakh target businesses (plumbers, salons, clinics in Karnataka, Andhra, Telangana) who already use personal WhatsApp.

---

## 2. Product Vision

**One-sentence vision:**  
A single executable that the owner installs on their laptop → scans QR once → AI replies instantly in WhatsApp → owner gets local dashboard + daily voice-note summary on the same machine.

**Core Pillars**  
- 100% self-hosted (no cloud server ever)  
- Personal WhatsApp number (multi-device protocol)  
- **Hardened Persistence**: SQLite + Filesystem mirroring for 100% data sovereignty  
- **Human-in-the-Loop**: Admin relay logic for unresolved query escalation  
- Local LLM or lightweight API fallback  
- Vertical knowledge packs (JSON + RAG)  
- Warm handoff + frustration detection  
- Anti-ban engine (jitter, typing simulation, delays)

**Success Criteria (MVP)**  
- 85%+ auto-resolution rate  
- Ban rate <15% in first 30 days (realistic target)  
- Owner can run it while laptop sleeps (with caveats – documented)

---

## 3. Critical Risks & Mitigations (MUST IMPLEMENT)

**Risk 1: Always-On Machine (Highest severity)**  
Mitigation:  
- Built-in “Sleep Mode” that pauses replies and auto-replies “We’ll reply in the morning”  
- Optional external cheap Raspberry Pi / old PC recommendation in docs  
- Battery drain warnings + auto-shutdown at low battery

**Risk 2: WhatsApp Permanent Bans (March 2026 reality)**  
Mitigation (best possible):  
- Gaussian reply delays (8–45s)  
- Typing simulation + read receipts control  
- Human-like message variation engine  
- Volume throttle (max 120 msgs/hour)  
- One-tap “Pause All” + backup chat export  
- Clear risk disclaimer on first launch

**Risk 3: Non-Tech Owner Friction**  
Mitigation:  
- One-click installer (NSIS for Windows, .dmg for Mac, AppImage for Linux)  
- Guided onboarding wizard with video  
- Local help chat (another LLM instance)

**Risk 4: Local LLM Performance**  
Mitigation:  
- Default to Ollama + Llama-3.2-3B or Phi-3 (runs on 8GB RAM)  
- Fallback to Groq/Anthropic API (user provides key, cost visible)

**Risk 5: Legal (DPDP Act + WhatsApp ToS)**  
Mitigation:  
- All data stays local (SQLite)  
- Show ToS warning screen on every launch  
- Export-only (no remote logging)

---

## 4. Detailed Product Requirements (PRD)

### 4.1 User Flows
1. **Installation & Onboarding (≤5 min)**  
   - Download executable → install → launch  
   - “Connect WhatsApp” → QR code appears (multi-device)  
   - Upload knowledge base (PDFs, Excel price list, Google Sheet link via local sync, calendar)  
   - Choose vertical pack (HVAC / Clinic / Salon / Generic)  
   - Set tone + languages (Kannada/English/Hindi auto-detect)

2. **Daily Operation**  
   - Customer messages → AI replies in <12s  
   - AI can: answer FAQs, book slots, send catalog, collect UPI intent, escalate  
   - Owner sees live list in local browser (http://localhost:3000)

3. **End of Day**  
   - 8 PM voice note (ElevenLabs local or edge TTS) + written summary  
   - Revenue impact, unresolved tickets, sentiment heatmap

### 4.2 Core Features (MVP Priority Order)
**P0 (Must have for launch) - ✅ COMPLETED**  
- WhatsApp multi-device connection (Baileys)  
- Local RAG (knowledge base JSON + vector store)  
- Reply generation + grounding  
- Basic dashboard (conversations, stats, export)  
- **Agent Persistence**: storage.db + brain/sessions/*.json mirroring  
- **Admin Relay**: Autonomous escalation of unresolved RAG queries  
- **Proactive Alerts**: 60s processing courtesy notifications  
- Daily summary (text + voice)  
- Warm handoff (AI pings owner in same chat with pre-written message)  
- Anti-ban engine (jitter/typing simulation)

**P1**  
- Vertical packs (3 pre-loaded)  
- Frustration detection (keywords + sentiment)  
- Google Sheet local sync (every 10 min)  
- UPI payment link generator  
- Multi-language (Google Translate local fallback or LibreTranslate)

**P2**  
- Team mode (multiple WhatsApp sessions)  
- Voice message support (Whisper local)  
- No-show reminders  
- One-click official API migration guide

---

## 5. System Architecture (Text Diagram)

```
Owner Laptop
├── Electron / Tauri Desktop App (main process)
│   ├── WhatsApp Module (Baileys multi-device)
│   ├── Local LLM Runner (Ollama or LM Studio API)
│   ├── RAG Engine (ChromaDB local or LanceDB)
│   ├── Anti-Ban Scheduler
│   └── SQLite DB (chats, knowledge, logs)
├── Local Web Dashboard (Vite + React, served on :3000)
├── Background Service (node.exe or daemon)
└── Voice TTS (Edge TTS or Piper local)
```

**Data Flow**  
Customer WhatsApp → Baileys event → RAG query → LLM prompt → reply → store in SQLite → dashboard update.

---

## 6. Recommended Tech Stack (2026 Stable)

- **Runtime:** Node.js 22 + Electron 32 (or Tauri 2.0 for smaller binary)  
- **WhatsApp:** Baileys (latest multi-device fork – https://github.com/WhiskeySockets/Baileys)  
- **LLM Local:** Ollama (default) + Llama-3.2-3B / Phi-3 / Gemma-2-9B  
- **Vector DB:** Chroma (local) or LanceDB (lighter)  
- **Frontend Dashboard:** Vite + React + Tailwind + shadcn/ui  
- **Database:** SQLite + Drizzle ORM  
- **TTS:** Edge-TTS or Piper (offline)  
- **Installer:** electron-builder (Windows .exe, Mac .dmg, Linux AppImage)  
- **Packaging:** Single 120–180 MB executable

**Optional Cloud Fallback (user controlled):**  
Groq (fastest) or Anthropic – API key stored locally only.

---

## 7. Folder Structure (Ready for AI Coding Agent)

```
/wa-co-pilot-selfhosted
├── src/
│   ├── main/                  # Electron main process
│   │   ├── whatsapp/          # Baileys connection + events
│   │   ├── rag/               # Chroma + document loader
│   │   ├── llm/               # Ollama wrapper + prompt templates
│   │   ├── anti-ban/          # Jitter + throttle engine
│   │   ├── dashboard/         # Express local server
│   │   └── summary/           # Daily voice + report generator
│   ├── renderer/              # React dashboard UI
│   ├── shared/                # Types, prompts, vertical packs
│   └── utils/
├── knowledge-base/            # Default JSON packs (HVAC.json, Clinic.json)
├── db/
│   └── app.db                 # SQLite
├── public/                    # Icons, videos
├── electron-builder.json
├── package.json
├── ollama-setup-guide.md
└── RISK-DISCLAIMER.md         # Must show on launch
```

---

## 8. Prompt Templates (Copy-Paste Ready)

**System Prompt (Vertical-aware):**  
```
You are a helpful, friendly Indian small business assistant for {business_name}.
Use only the provided knowledge base. Speak in natural {language} mix.
Never hallucinate prices or availability.
If unsure → say "Let me check with the owner and reply shortly" and trigger warm handoff.
Tone: polite, fast, local (use "sir/madam", Kannada words when detected).
```

**Warm Handoff Trigger Prompt:**  
Detect frustration score >7 → generate owner message + full context JSON.

---

## 9. Implementation Roadmap for AI Coding Agent

**Phase 1 (Week 1 – Core Connection)**  
1. Set up Electron + Baileys multi-device QR  
2. Basic reply echo bot  
3. SQLite chat logging  

**Phase 2 (Week 2 – LLM + RAG)**  
4. Ollama integration + simple prompt  
5. Chroma vector store + PDF/Excel loader  
6. Vertical pack loader  

**Phase 3 (Week 3 – Dashboard + Features)**  
7. Local Vite React dashboard (live conversation list)  
8. Daily summary generator + TTS voice note  
9. Anti-ban engine (delays + typing)  

**Phase 4 (Week 4 – Polish & Vertical)**  
10. Warm handoff + frustration detection  
11. 3 vertical JSON packs  
12. Installer + risk disclaimer screen  

**Phase 5 (Testing)**  
- Test with 5 real Karnataka numbers (monitor ban rate)  
- Document “laptop must stay on” limitations clearly

---

## 10. Pricing & Licensing Model (Self-Hosted)

- One-time license: ₹4,999 (Pro)  
- Vertical packs: ₹999 each  
- Lifetime updates: ₹1,999 (optional)  
- White-label for agencies: ₹29,999 one-time  

No recurring → owner owns everything.

---

## 11. Competitive Battle Cards (Internal)

(See earlier conversation – AIConsumerAgent wins on privacy & zero fees, loses on reliability vs official API tools.)

---

## 12. Final Notes for AI Coding Agent

- Start with `package.json` and Electron boilerplate.  
- Include the full RISK-DISCLAIMER.md that must pop up on every launch.  
- Make the installer as simple as “double-click → next → next → done”.  
- Default language: English + Kannada detection.  
- All paths must be relative – no absolute cloud URLs.  

**Ready to code.**  
Copy this entire MD into your AI coding agent (Claude 3.5 / Grok-4 / Cursor) and say:  
“Build the full self-hosted AIConsumerAgent desktop app exactly as specified in this blueprint, starting with Phase 1.”

You now have everything we researched in one executable-ready document.  

Good luck — this will be the most privacy-first WhatsApp AI tool in India in 2026.

**Next step from you:** Tell me when you want the first 500 lines of starter code or the exact `package.json`.
```

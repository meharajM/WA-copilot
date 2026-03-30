# AIConsumerAgent: Company and Product Overview

**Version:** 1.0.0  
**Last Updated:** March 2026  
**Website:** www.aica.com

## About AIConsumerAgent
AIConsumerAgent is an autonomous, self-hosted WhatsApp AI agent designed for privacy-first business automation. We empower small-to-medium businesses and enterprise teams to handle customer support, execute complex operational tasks, and manage their knowledge bases—all natively through WhatsApp.

By bringing agentic workflows directly to where conversations happen, AIConsumerAgent eliminates the need for clunky custom dashboards, providing a seamless "ChatOps" experience for business owners and their clients.

## Core Product Offerings

### 1. The Autonomous AIConsumerAgent
Our flagship desktop application (available for macOS, Windows, and Linux). The AIConsumerAgent agent acts as an autonomous employee capable of reading WhatsApp messages, reasoning about them, and executing complex, multi-step tasks.
- **Privacy-First:** Run the core Brain (LLM) locally using WebLLM or Ollama to guarantee 100% data privacy.
- **API Flexibility:** Optional integrations with OpenAI, Gemini, Groq, Anthropic, and OpenRouter for complex reasoning loops.
- **Self-Healing Automation:** The agent can autonomously navigate UI changes, resolve package dependencies, and alert humans only when explicit approval is required.

### 2. Extensible MCP (Model Context Protocol) Plugin Ecosystem
AIConsumerAgent is infinitely expandable. Through the open MCP standard, the agent can connect to external business tools:
- **Filesystem & System Shell:** Allowing the agent to run terminal commands, manage local databases, and scaffold new code.
- **Playwright Browser Agent:** Giving the AI the ability to invisibly surf the web, scrape data, or interact with web-based CRM dashboards on your behalf.
- **RAG Knowledge Engine:** (Retrieval-Augmented Generation) The agent securely ingests your business documents (PDFs, Spreadsheets, Markdown) into a lightning-fast SQLite/LanceDB backend, ensuring every answer the agent gives is strictly constrained by your company's actual data.

## Pricing and Licensing

AIConsumerAgent is built on a freemium open-source model designed to scale with your business:

| Plan | Price (Monthly) | Features Included |
| :--- | :--- | :--- |
| **Community Edition** | $0 (Free Forever) | Local LLM support, 1 WhatsApp account, basic filesystem MCP |
| **Pro Business** | $49/mo | Unlimited MCP plugins, Playwright automation, Unlimited RAG ingestion, priority email support |
| **Enterprise Fleet** | Custom Pricing | Multi-tenant deployments, centralized secure keys, dedicated account manager |

## Support and SLAs

Our customer support team is available globally to quickly resolve technical issues and assist with RAG memory tuning.
- **Support Email:** support@aica.com
- **Enterprise SLA:** 99.9% guaranteed uptime for enterprise relay infrastructure; 4-hour response time for critical technical blockers.
- **Community Support:** Join our active Discord community for the Community Edition.

## Frequently Asked Questions (FAQ)

**Q: Do I need to be a developer to use AIConsumerAgent?**
A: No! The desktop application features a user-friendly UI. You can simply scan a WhatsApp QR code to connect the agent, drag-and-drop your company documents into the training dashboard, and the AI takes over from there.

**Q: Are my company documents sent to OpenAI?**
A: That depends on your settings. If you select "Browser" or "Ollama" as your provider, your RAG ingestion and reasoning pipelines happen entirely on your local machine. If you use OpenAI/Gemini, the context chunks are securely sent via API.

**Q: How does the agent handle actions it's unsure about?**
A: AIConsumerAgent features strict "Human-in-the-Loop" capabilities. If an action is potentially destructive (e.g., executing a dangerous terminal command or sending a refund), the agent will message you on WhatsApp for approval before executing it.

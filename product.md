# AIConsumerAgent: Product Overview

## How it Works
To understand how **AIConsumerAgent** works, it’s easiest to think of it as a digital employee sitting at a computer, autonomously handling your customer support. 

Here is a breakdown of the four main "organs" that make up this application, and exactly what happens when a customer sends a message.

---

### 1. The Mouth & Ears: WhatsApp Bridge
Unlike a standard chatbot that lives on a website, this app connects directly to a real WhatsApp phone number. 
*   **How it works:** The app runs a background process (using a library called `Baileys`) that acts exactly like "WhatsApp Web." You scan a QR code in the app's Settings, and from then on, the app "listens" to every incoming message and can "type" replies back to customers.

### 2. The Brain: The Agent & LLM
When a message comes in, it doesn't just trigger a rigid pre-programmed response (like "Press 1 for Sales"). It goes to an **Autonomous Agent**.
*   **How it works:** The Agent looks at the message and decides what to do. It consults a Large Language Model (LLM)—like OpenAI, Gemini, or a locally running model.
*   **The Persona:** We have instructed the "Brain" via a System Prompt to act specifically as a *Professional WhatsApp Business Support Agent*. It knows it must be polite, concise, and use emojis appropriately for mobile users.

### 3. The Memory: Knowledge Base (RAG)
If a customer asks, *"What is your refund policy?"*, the LLM typically wouldn't know your specific business rules. This is where **RAG** (Retrieval-Augmented Generation) comes in.
*   **How it works:** You can feed the app your business documents, PDFs, pricing sheets, or FAQs. The app chunks these documents into pieces and saves them in a local database (`LanceDB`). 
*   Before answering the customer, the Agent searches this local database for the exact paragraphs relating to "refunds", reads them, and *then* writes the reply. It relies on *your data*, not generic internet knowledge.

### 4. The Action Center: MCP Tools
Sometimes a customer needs actual work done, not just text answers (e.g., *"Where is my order?"*).
*   **How it works:** The app supports **MCP** (Model Context Protocol). This means you can plug in external tools. If connected to a Shopify tool, the Agent can actually tell the computer to look up an order number, fetch the shipping status, and send that status back to the customer on WhatsApp.

---

### 🔁 The Step-by-Step Flow (What happens when a customer texts you)

1.  **Receive**: A customer texts *"Do you have the Nike shoes in size 10?"* to your business number.
2.  **Intercept**: The Electron app (Main Process) catches the message instantly via the WhatsApp connection.
3.  **Think**: The UI (Renderer Process) spins up the `AgentRuntime` for that specific phone number. The Agent says, "I need to check inventory."
4.  **Search**: The Agent secretly searches your local Knowledge Base or triggers an MCP tool to check your stock.
5.  **Reply**: The LLM formulates a friendly response: *"Yes! We have the Nike shoes in size 10 in stock. Would you like a link to purchase? 👟"*
6.  **Send**: The app routes that text back through the WhatsApp connection directly to the customer's phone. 

Meanwhile, as the business owner, you are sitting at the **Dashboard (The UI)**, watching the "Messages Today", "Active Leads", and "Indexed Docs" numbers update. You can also monitor **Conversation Topics** (analyzed via LLM) to see what your customers care about most, and upload new training data to the knowledge base at any time.

When a customer's query is handled, you can click **"Resolve Conversation"** to mark it as complete, which triggers an automated AI summary and categorization for your business analytics. 

---

## 🚀 Roadmap: Omnichannel Expansion
While AIConsumerAgent currently focuses heavily on WhatsApp, the underlying Agent Architecture (Reasoning loop, RAG integration, and MCP Tools) is entirely platform-agnostic. 

Future updates intend to scale the application into an **Omnichannel Business Hub** by bridging additional communication layers:

1. **SMS / Text Messaging**
   * **Integration**: Twilio or Plivo APIs.
   * **Use Case**: Fallback communication, marketing blasts, and reaching customers who prefer native messaging.
2. **Email Orchestration**
   * **Integration**: IMAP/SMTP bridging or direct Microsoft Graph / Google Workspace integrations.
   * **Use Case**: Automatically triaging customer support emails, answering frequent inquiries with RAG data, and drafting complex email responses for human review.
3. **Social Messaging Platforms**
   * **Integration**: Instagram Direct Messages (DM), Facebook Messenger, and Telegram.
   * **Use Case**: Engaging with users natively where they discover the brand, offering seamless shopping or booking experiences without requiring them to switch apps.

The goal is to maintain a unified AI "Brain" across all channels, so a customer can start a conversation on Instagram, shift to WhatsApp, and receive an email receipt without the agent ever losing context.

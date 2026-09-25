# Defense Cheat Sheet: Grow and Feeds Patrons

**Core Rule:** Always use State -> Context -> Evidence. 

**Fallback Rule:** If truly stumped, use: "I don't have that exact metric right now, but here is exactly how I would find out: [specific action]."

---

## Q1: "What happens if 500 farmers message the bot at the exact same time? Won't your server crash?"

- **State:** The current MVP is optimized for rapid validation and low-to-moderate concurrent load, but we have a documented, clear path to horizontal scaling.
- **Context:** We prioritized building a fully functional end-to-end workflow over premature optimization. We used Render's free tier to validate the core logic without incurring infrastructure costs.
- **Evidence:** We actively mitigated the immediate free-tier spin-down issue by implementing a 5-minute UptimeRobot ping. Furthermore, in our `TRADE_OFFS.md`, we explicitly documented that for production, we will migrate our in-memory webhook deduplication `Map` to a distributed cache like Redis, and move the backend to a containerized, auto-scaling environment (like AWS ECS or Render's paid tier) to handle concurrent webhook spikes.

## Q2: "Generative AI hallucinates. What if your bot promises a farmer a pickup time or price that doesn't exist?"

- **State:** We strictly constrain the AI's behavior using rigid system prompts and hardcoded fallback mechanisms to prevent operational hallucinations.
- **Context:** We recognized early that allowing an LLM to make binding logistical commitments is a major risk in a real-world agribusiness setting.
- **Evidence:** In `server.js`, the Qwen API call is wrapped in a strict system prompt that explicitly commands: "Keep answers under 300 characters... If the user asks about waste pickup, gently remind them to reply with 'Hi' to start a formal request." Additionally, the `getAIResponse` function is wrapped in a `try/catch` block. If the AI API fails, times out, or returns null, the code immediately falls back to a safe, hardcoded message: "I did not understand that. Please send 'Hi' to start a new pickup request."

## Q3: "You are collecting phone numbers and physical locations. How is this data secured, and who can access it?"

- **State:** The system uses a multi-layered security approach, strictly separating public webhook intake from protected operator actions.
- **Context:** Patron PII (Personally Identifiable Information) is sensitive, and the operator dashboard must not be exposed to the public internet.
- **Evidence:** The dashboard API routes are protected by a custom `requireDashboardKey` middleware that validates a secret `x-api-key` header on every request. Furthermore, sensitive credentials like `SUPABASE_SERVICE_ROLE_KEY` and `WHATSAPP_ACCESS_TOKEN` are never committed to GitHub; they are strictly managed via Render's secure, encrypted environment variables.

## Q4: "What if a field worker is assigned a pickup in a rural area with no data connectivity to receive the WhatsApp button?"

- **State:** We currently rely entirely on WhatsApp, which is a conscious MVP trade-off, but we have a defined fallback strategy for production.
- **Context:** Our target demographic in Kenya has extremely high WhatsApp penetration, making it the lowest-friction, zero-install entry point. However, we acknowledge that rural dead zones are a real operational risk.
- **Evidence:** As documented in our `TRADE_OFFS.md`, our immediate post-MVP roadmap includes integrating the Africa's Talking SMS API. The production logic will attempt to send the WhatsApp message first; if the Meta delivery webhook returns a failure status, the system will automatically cascade to an SMS fallback to ensure the field worker still receives the assignment details.

## Q5: "What happens if a patron sends an emoji, or types 'Hi' in the middle of the 5-step form?"

- **State:** The bot gracefully handles unexpected inputs by either delegating to the AI fallback or cleanly resetting the conversational state without crashing.
- **Context:** Real users do not follow linear forms perfectly. The system must be resilient to chaotic input.
- **Evidence:** We moved the session state to a persistent Supabase `sessions` table. If a user sends an unrecognized input (like an emoji) that doesn't match our strict `if/else` flow, it bypasses the form and triggers the `getAIResponse` function to handle it conversationally. If they explicitly send "Hi" mid-flow, the code detects this trigger word, overwrites the existing session state back to `'name'`, and cleanly restarts the intake process.

---

## The "I Don't Know" Protocol

If a judge asks a highly specific question you genuinely cannot answer (e.g., "What is the exact carbon offset metric per kg of manure?" or "What is the max RPS of the ModelScope API?"), do not guess. Use this exact formula:

> "That is an excellent question. I don't have that exact metric memorized right now, but here is exactly how I would find out: I would query the `pickup_events` table in Supabase to aggregate the historical data, and then cross-reference it with the standard BSF methane reduction metrics from the World Farmers' Organisation to give you a precise number."

**Why this works:** It shows you know where the data lives and how your system is structured, which is often more impressive to technical judges than a memorized statistic.

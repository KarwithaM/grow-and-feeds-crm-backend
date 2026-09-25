# System Trade-offs and Architectural Decisions

Every engineering project involves balancing speed, cost, and scalability. In building the Grow and Feeds Patrons MVP, we made several conscious trade-offs to deliver a functional, end-to-end system within the hackathon timeframe. We are proactively surfacing these limitations, why we accepted them, and how we would address them in a production environment.

## 1. Client-Side Dashboard Filtering vs. Server-Side Pagination
**The Trade-off:** 
The Operator Dashboard fetches all `pickup_requests` from the database at once and performs filtering (by status, location, and waste type) entirely in the browser's memory using JavaScript.

**Why We Accepted It:** 
For the MVP phase, the volume of records is low (dozens to low hundreds). Client-side filtering provides an instant, zero-latency user experience without requiring complex backend query parameter parsing, database indexing, or pagination logic. It allowed us to ship the filtering feature rapidly.

**What We Would Do Differently:** 
As the system scales to thousands of historical records, fetching the entire table will become a performance bottleneck for both the Supabase database and the client's browser. In production, we would implement server-side pagination and indexed queries (e.g., `GET /api/pickup-requests?status=pending&location=Nairobi+West&page=1&limit=50`) to ensure the API only returns the exact data needed for the current view.

## 2. In-Memory Webhook Deduplication
**The Trade-off:** 
To prevent Meta from processing the same webhook payload twice (a known behavior of the WhatsApp Cloud API during network retries), we use a Node.js `Map` (`processedMessages`) to store recently seen message IDs for 10 minutes.

**Why We Accepted It:** 
It is extremely fast, requires zero external dependencies, and is perfectly adequate for a single-instance deployment on Render. It successfully prevents duplicate database inserts during our current testing phase.

**What We Would Do Differently:** 
An in-memory `Map` is tied to a single server process. If we scale the backend horizontally to multiple instances to handle high traffic, the deduplication state will not be shared, leading to potential race conditions and duplicate processing. In production, we would replace the `Map` with a distributed, ephemeral cache like Redis, using the message ID as the key with a 10-minute Time-To-Live (TTL).

## 3. WhatsApp-Only Communication Channel
**The Trade-off:** 
The entire operational loop (patron intake, worker assignment, and status updates) relies exclusively on the Meta WhatsApp Cloud API. 

**Why We Accepted It:** 
WhatsApp has near-ubiquitous penetration in our target demographic in Kenya, making it the lowest-friction channel for both low-literacy patrons and field workers. Adding a secondary communication channel would have significantly increased the scope, cost, and complexity of the MVP.

**What We Would Do Differently:** 
Field workers occasionally operate in areas with poor data connectivity, where WhatsApp messages may fail to deliver. In production, we would implement a multi-channel notification service (e.g., integrating the Africa's Talking SMS API). The system would attempt to send the WhatsApp message first, and if the delivery webhook returns a failure status, it would automatically fall back to sending a standard SMS with a short link or USSD code.

## 4. Render Free-Tier Infrastructure
**The Trade-off:** 
The backend is hosted on Render's free tier, which automatically spins down the server after 15 minutes of inactivity. 

**Why We Accepted It:** 
It provides a zero-cost, fully managed deployment environment with automatic HTTPS and GitHub CI/CD, which is ideal for an MVP. We mitigated the spin-down latency by configuring UptimeRobot to ping the server every 5 minutes, keeping it "warm" during active development and testing.

**What We Would Do Differently:** 
Relying on a ping service is a brittle workaround. In a production environment serving real farmers and workers, we require guaranteed uptime and the ability to handle sudden spikes in concurrent webhook deliveries. We would migrate to a scalable, always-on container orchestration service (such as Render's paid tier, Railway, or AWS ECS/Fargate) with proper auto-scaling and load balancing.

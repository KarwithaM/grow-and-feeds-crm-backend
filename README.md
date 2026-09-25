## Hack for Humanity Submission

**Problem:** Smallholder farmers and market vendors struggle with inconsistent, manual organic waste disposal, leading to environmental degradation and lost economic value. Simultaneously, sustainable agriculture lacks accessible, high-quality organic fertiliser and animal feed.

**Solution:** Grow And Feeds Patrons is an automated, WhatsApp-based waste collection and coordination CRM. It bridges the gap between waste generators and sustainable Black Soldier Fly (BSF) processing facilities. By leveraging smart dispatch, real-time operator dashboards, and a three-step transparency notification system, we eliminate logistical friction, reduce spoilage, and build trust with rural and peri-urban communities.

**Impact:** Transforms organic waste into valuable BSF larvae and frass, creating a circular economy that supports local agribusinesses while cleaning up the environment.

# Grow and Feeds Patrons - Backend CRM

A lightweight, production-oriented Node.js/Express backend powering the WhatsApp conversational intake and operational coordination for the **Grow and Feeds Patrons** organic waste collection system. 

This system allows patrons (farmers, market vendors, etc.) to request organic waste pickups directly via WhatsApp, while storing all operational data in a persistent PostgreSQL database.

## Architecture & Tech Stack

This project is built on the architecture adapted for waste collection logistics.

| Layer | Technology | Responsibility |
| :--- | :--- | :--- |
| **User Channel** | Meta WhatsApp Cloud API | Patron intake and conversational state |
| **Application** | Node.js + Express | Business logic, webhooks, status transitions, AI fallback |
| **Database** | Supabase (PostgreSQL) | Persistent operational source of truth |
| **Hosting** | Render | Production hosting, environment, logs |
| **Source/Deploy** | GitHub → Render | Version control and automated deployment |

**Architecture Flow:**
`Patron → WhatsApp Cloud API → Node.js/Express → Supabase PostgreSQL`

## Features

- **Conversational Intake:** Step-by-step WhatsApp flow to collect patron details, waste type, volume, and location.
- **Persistent State Management:** Supabase-backed session handling ensures patron progress survives server restarts or spin-downs.
- **Smart Dispatch Algorithm:** Backend logic that matches incoming pickup locations against field workers' service areas to optimize routing and reduce fuel costs.
- **Three-Step Patron Transparency:** Automated WhatsApp notifications to patrons when a worker is assigned, when waste is safely received, and when it is successfully processed.
- **AI-Powered Conversational Fallback:** Integrated Qwen API to handle out-of-flow patron questions, providing intelligent, brand-aligned responses about business operations.
- **Secure Operator Dashboard:** Lightweight web interface protected by an API key for viewing requests, managing field workers, and triggering auto-assignment.

## Data Model

The system relies on four core tables in Supabase:

1. **pickup_requests:** Stores the patron's name, phone, location, waste type, estimated volume, assigned worker, and canonical status (pending, assigned, collected, processed, cancelled).
2. **field_workers:** Stores the operational workers/collectors, their phone numbers, and availability status (available or busy).
3. **pickup_events:** An audit log tracking every significant status change for operational visibility and troubleshooting.
4. **sessions:** Stores active WhatsApp conversational state per phone number to ensure continuity across server restarts.

## WhatsApp Conversational Workflow

1. Patron sends **`Hi`**.
2. Bot asks for **Patron Name**.
3. Bot asks for **Waste Type** (`fruit_veg`, `crop_residue`, or `manure`).
4. Bot asks for **Estimated Volume** (in kg).
5. Bot asks for **Pickup Location**.
6. Bot presents a **Summary** and asks for **YES/NO** confirmation.
7. On **YES**, the system creates a `pending` record in Supabase and confirms the request.

## Environment Variables

To run this project, you must configure the following environment variables (e.g., in your Render Dashboard or a local `.env` file):

| Variable | Purpose |
| :--- | :--- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend database authentication (Keep secret) |
| `WHATSAPP_VERIFY_TOKEN` | Webhook verification token for Meta |
| `WHATSAPP_ACCESS_TOKEN` | Meta API access token (Keep secret) |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta phone number ID for sending messages |
| `DASHBOARD_API_KEY` | Secret key required to access the Operator Dashboard API |
| `QWEN_API_KEY` | API key for ModelScope/Qwen AI conversational fallback |
| `PORT` | Render application port (defaults to 10000) |


## Local Setup & Installation

1. **Clone the repository:**
   git clone https://github.com/KarwithaM/grow-and-feeds-crm-backend.git
   cd grow-and-feeds-crm-backend

2. **Install dependencies:**
   npm install

3. **Configure environment variables:**
   Create a .env file in the root directory and add the variables listed in the Environment Variables section above.

4. **Run the development server:**
   npm run dev

## Deployment

This application is deployed on Render via continuous deployment from the main branch on GitHub.
- Build Command: npm install
- Start Command: npm start
Note: Because this runs on Render's free tier, the server may spin down after periods of inactivity. An external uptime monitor (like UptimeRobot) is recommended to keep the webhook responsive.

## Current Limitations

**Development Mode:** The Meta WhatsApp integration is currently in Development Mode, restricting inbound messages to explicitly added test numbers within a 24-hour customer service window.
**SMS Fallback:** Auxiliary SMS notifications for field workers are not yet integrated (relies entirely on WhatsApp).

## Next System Increments

Future development will focus on:
- **Dashboard Search and Filtering**: Adding operational visibility features to filter requests by date, status, waste type, or location.
- **Operational Metrics**: Adding reporting dashboards (e.g., total kg collected per week, top service areas).
- **Permanent Meta Access Token and Live Mode**: Transitioning to a permanent System User Access Token and promoting the app to remove test-number restrictions.

## Field Worker Workflow (Logistics)
1. Operator views `pending` requests on the secure Operator Dashboard.
2. Operator assigns an `available` field worker to a pickup request.
3. System updates the request status to `assigned` and logs the event in `pickup_events`.
4. System automatically sends a WhatsApp notification to the assigned field worker with pickup details.
5. Field worker executes the pickup and updates the status via WhatsApp interactive buttons (e.g., `Mark Collected`).
6. System updates the request status to `collected` and frees up the field worker for the next assignment.

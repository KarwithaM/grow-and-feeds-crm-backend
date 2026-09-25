# Grow and Feeds Patrons - Backend CRM

A lightweight, production-oriented Node.js/Express backend powering the WhatsApp conversational intake and operational coordination for the **Grow and Feeds Patrons** organic waste collection system. 

This system allows patrons (farmers, market vendors, etc.) to request organic waste pickups directly via WhatsApp, while storing all operational data in a persistent PostgreSQL database.

## Architecture & Tech Stack

This project is built on the architecture adapted for waste collection logistics.

| Layer | Technology | Responsibility |
| :--- | :--- | :--- |
| **User Channel** | Meta WhatsApp Cloud API | Patron intake and conversational state |
| **Application** | Node.js + Express | Business logic, webhooks, status transitions |
| **Database** | Supabase (PostgreSQL) | Persistent operational source of truth |
| **Hosting** | Render | Production hosting, environment, logs |
| **Source/Deploy** | GitHub → Render | Version control and automated deployment |

**Architecture Flow:**
`Patron → WhatsApp Cloud API → Node.js/Express → Supabase PostgreSQL`

## Features

- **Conversational Intake:** Step-by-step WhatsApp flow to collect patron details, waste type, volume, and location.
- **State Management:** In-memory session handling to guide users through the multi-step request process.
- **Data Persistence:** Automatically saves confirmed pickup requests to Supabase with a `pending` status.
- **Observability:** Deep logging for inbound Meta payloads and parsed message data to aid in troubleshooting.
- **Phone Normalization:** Automatically formats incoming phone numbers to ensure consistent database matching.

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
| `SUPABASE_SERVICE_ROLE_KEY` | Backend database authentication (Keep secret!) |
| `WHATSAPP_VERIFY_TOKEN` | Webhook verification token for Meta |
| `WHATSAPP_ACCESS_TOKEN` | Meta API access token (Keep secret!) |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta phone number ID for sending messages |
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
Build Command: npm install
Start Command: npm start
Note: Because this runs on Render's free tier, the server may spin down after periods of inactivity. An external uptime monitor (like UptimeRobot) is recommended to keep the webhook responsive.

## Current Limitations

**Development Mode:** The Meta WhatsApp integration is currently in Development Mode, restricting inbound messages to explicitly added test numbers within a 24-hour customer service window.
**SMS Fallback:** Auxiliary SMS notifications for field workers are not yet integrated (relies entirely on WhatsApp).

## Next System Increments

Future development will focus on:
- Transitioning to a permanent Meta System User Access Token.
- Promoting the Meta App to Live Mode to remove test-number restrictions.
- Implementing WhatsApp interactive buttons for field workers to update pickup statuses (e.g., "Mark Picked Up") directly from their phones.

## Field Worker Workflow (Logistics)
1. Operator views `pending` requests on the secure Operator Dashboard.
2. Operator assigns an `available` field worker to a pickup request.
3. System updates the request status to `assigned` and logs the event in `pickup_events`.
4. System automatically sends a WhatsApp notification to the assigned field worker with pickup details.
5. Field worker executes the pickup and updates the status via WhatsApp interactive buttons (e.g., `Mark Collected`).
6. System updates the request status to `collected` and frees up the field worker for the next assignment.

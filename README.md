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

The system relies on three core tables in Supabase:

1. **`pickup_requests`**: Stores the patron's name, phone, location, waste type, estimated volume, and canonical status (`pending`, `assigned`, `collected`, `processed`).
2. **`field_workers`**: Stores the operational workers/collectors and their availability status (`available` or `busy`).
3. **`pickup_events`**: An audit log tracking every significant status change for operational visibility.

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

**In-Memory Sessions:** WhatsApp conversation state is stored in application memory. A Render restart/spin-down may lose an active, incomplete conversation (Patron will need to send "Hi" again).
**Development Mode:** The Meta WhatsApp integration is currently in Development Mode, restricting inbound messages to explicitly added test numbers within a 24-hour customer service window.

## Next System Increments

Future development will focus on:
- Persisting WhatsApp sessions in Supabase to survive server restarts.
- Transitioning to a permanent Meta System User Access Token.
- Promoting the Meta App to Live Mode to remove test-number restrictions.
- Building the Operator Dashboard for assigning pickups to field workers.
- Implementing dashboard authentication and role-based authorization.

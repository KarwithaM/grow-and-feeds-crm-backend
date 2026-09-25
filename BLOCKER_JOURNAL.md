# Grow and Feeds Patrons MVP 001: Blocker Journal

**Project:** Grow And Feeds Patrons (Waste Collection CRM)  
**Date:** September 2026  
**Status:** Backend Integration, Smart Dispatch, and AI Features Resolved  

## Executive Summary
This journal tracks the critical blockers encountered while building the architecture for the Grow And Feeds Patrons waste collection workflow. The primary challenges centered around Meta WhatsApp Cloud API Development Mode restrictions, Render free-tier infrastructure limitations, silent failure modes in the Node.js/Express webhook handler, and AI integration quirks. All blockers have been successfully resolved, resulting in a fully functional, production-grade system featuring Smart Dispatch, Three-Step Patron Transparency, and Qwen-powered AI reporting and conversational fallback.

---

## Blocker #1: Silent Webhook Skips & AI Fallback State Restriction
**Symptom:** Inbound WhatsApp messages triggered the `Webhook POST received` log, but the bot failed to reply. Specifically, asking out-of-flow questions like "What is a Black Soldier Fly?" resulted in absolute silence.  
**Root Cause:**  
1. Initial silent crashes were caused by aggressive `try/catch` blocks swallowing errors without logging them.  
2. The AI fallback logic was wrapped in `if (session.state !== 'greeting')`. Since a fresh conversation starts in the `'greeting'` state, the condition evaluated to `false`, causing the bot to silently ignore the question while waiting for the "Hi" trigger.  
**Resolution:**  
- Implemented aggressive, step-by-step numbered logging (`1. Webhook received`, `2. Body parsed`, etc.) to pinpoint the exact line of failure.  
- Removed the `greeting` state restriction, transforming the AI fallback into a true catch-all that answers *any* unrecognized query, even before the formal intake flow begins.

## Blocker #2: Node.js ES Module Import Order Crash
**Symptom:** After adding the Qwen API integration, the server logged `Webhook POST received` but crashed silently immediately after, with no error output.  
**Root Cause:** The statement `import { OpenAI } from 'openai';` was accidentally placed in the middle of the `server.js` file. Node.js ES modules strictly require all `import` statements to be at the very top of the file. Placing it mid-file caused a silent syntax failure.  
**Resolution:** Moved the `OpenAI` import to the very top of `server.js` alongside other imports. Additionally, ensured `"openai": "^4.28.0"` was explicitly added to `package.json` dependencies so Render's build step could install it successfully.

## Blocker #3: Meta Development Mode "Ghost" Drops
**Symptom:** Meta's internal logs showed the inbound JSON payload was successfully sent, but Render logs remained completely silent. No POST request ever reached the server.  
**Root Cause:** Meta's Development Mode acts as a strict bouncer. It silently drops inbound messages if:  
- The sender's phone number is not explicitly added to the "Test Phone Numbers" list.  
- The message is sent outside the 24-hour customer service window.  
**Resolution:** Verified the exact Phone Number ID mapping in the Meta Webhook configuration and ensured all testing numbers were explicitly added as testers in the Meta Developer Console.

## Blocker #4: Render Free-Tier Spin-Down Timeout
**Symptom:** When testing after a period of inactivity, Meta logged the message, but Render showed no logs.  
**Root Cause:** Render's free tier spins down the server after ~15 minutes of inactivity. Meta's webhook timeout is ~10-15 seconds, but Render takes ~50 seconds to wake up. Meta assumes the server is dead and drops the request.  
**Resolution:** Implemented a "Wake-Up & Strike" protocol (using `curl` to ping the server before testing). Configured UptimeRobot to ping the server every 5 minutes to keep it warm and responsive.

## Blocker #5: Expired Meta Access Token (Silent Outbound Failure)
**Symptom:** The server successfully received the webhook, but the WhatsApp user never received the bot's reply.  
**Root Cause:** Meta's temporary Access Token expires or is hidden from the UI when navigating away. The server received the message but failed silently when trying to authenticate the outbound `sendWhatsAppMessage` API call.  
**Resolution:** Regenerated the Access Token in Meta and updated the `WHATSAPP_ACCESS_TOKEN` environment variable in Render. Added explicit error logging to the outbound message function to catch future authentication failures.

## Blocker #6: Yarn Registry 404 Build Failure
**Symptom:** Render deployment failed with error: `https://registry.yarnpkg.com/@supabase/storage-js/-/storage-js-2.117.1.tgz: Request failed "404 Not Found"`.  
**Root Cause:** Yarn's package registry cache on Render temporarily failed to resolve a specific Supabase sub-dependency.  
**Resolution:** Switched the Render Build and Start commands from `yarn` to `npm install` and `npm start`, which handled the registry resolution more robustly.

## Blocker #7: Database Schema Dependency Error
**Symptom:** Supabase SQL Editor returned `ERROR: 42P01: relation "field_workers" does not exist`.  
**Root Cause:** The `pickup_requests` table was created before the `field_workers` table, but it contained a foreign key reference to `field_workers`.  
**Resolution:** Reordered the SQL migration script to create `field_workers` first, followed by `pickup_requests`, and finally `pickup_events`.

## Blocker #8: Stale Webhook Callback URL
**Symptom:** After migrating to a new GitHub repository (`grow-and-feeds-crm-backend`), Meta showed the payload in its logs, but the new Render server received nothing.  
**Root Cause:** The Callback URL in Meta was still pointing to the old repository's Render URL.  
**Resolution:** Updated the Meta Webhook Callback URL to the exact new URL: `https://grow-and-feeds-crm-backend.onrender.com/api/whatsapp/webhook`.

## Blocker #9: Dashboard Rendering Crash During Filter Implementation
**Symptom:** After adding client-side filtering to the dashboard, the table stopped loading entirely, showing a blank screen.  
**Root Cause:** When replacing the top of the `render(data)` function to add filter logic, essential DOM references (`rowsEl`, `emptyEl`) and the `workerOptions` helper function were accidentally deleted.  
**Resolution:** Restored the complete `render` function, carefully integrating the new location and waste-type filter logic while preserving all original DOM manipulation and dropdown population logic.

---

## Current System Status
- **Backend:** Live on Render (`grow-and-feeds-crm-backend`).  
- **Database:** Supabase PostgreSQL configured with `pickup_requests`, `field_workers` (including `service_area`), `pickup_events`, and `sessions` (for persistent conversational state).  
- **Integration:** Meta WhatsApp Cloud API webhook successfully verified and routing messages.  
- **Workflow:** Conversational intake flow is fully operational.  
- **Advanced Features:**  
  - **Smart Dispatch:** Auto-assigns workers based on `service_area` matching.  
  - **Three-Step Transparency:** Patrons receive automated WhatsApp updates at Assignment, Collection, and Processing.  
  - **AI Fallback:** Qwen API handles out-of-flow patron questions intelligently.  
  - **AI Impact Reporting:** One-click generation of weekly environmental impact summaries.  
  - **Dashboard Filtering:** Real-time client-side filtering by status, location, and waste type.

---

## Future Mitigations (Next Increments)
To prevent recurrence of these blockers and scale the system for production, the following increments are planned:  
1. **Permanent Access Token:** Transition from a temporary 24-hour Access Token to a permanent System User Access Token via Meta Business Manager.  
2. **App Promotion:** Move the Meta App from "Development Mode" to "Live Mode" to remove the 24-hour window and test-number restrictions.  
3. **SMS Fallback:** Integrate Africa's Talking SMS API as a backup communication channel for field workers in low-connectivity areas.  
4. **Advanced Historical Analytics:** Expand the AI reporting to include month-over-month growth trends and predictive volume forecasting.

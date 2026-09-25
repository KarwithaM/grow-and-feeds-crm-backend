## Grow and Feeds Patrons MVP 001:

**Project**: Grow And Feeds Patrons (Waste Collection CRM)
**Date**: September 2026
**Status**: Backend Integration & Webhook Routing Resolved

## Executive Summary
This journal tracks the critical blockers encountered while building the architecture for the Grow And Feeds Patrons waste collection workflow. The primary challenges centered around Meta WhatsApp Cloud API Development Mode restrictions, Render free-tier infrastructure limitations, and silent failure modes in the Node.js/Express webhook handler. All blockers have been successfully resolved, resulting in a fully functional end-to-end conversational intake flow.

## Blocker #1: Silent Webhook Skips & Missing State

**Symptom**: Inbound WhatsApp messages triggered the Webhook POST received log, but the bot failed to reply. No error logs were generated.
**Root Cause:** 
- A missing variable declaration (let session = ...) caused a ReferenceError that was caught by the global try/catch block, resulting in a silent failure.
- Lack of deep observability logs made it impossible to see how the payload was being parsed.
**Resolution:** Restored the session variable declaration. Implemented deep observability logging to print the RAW META PAYLOAD and Parsed FROM/TEXT variables.

## Blocker #2: Meta Development Mode "Ghost" Drops

**Symptom:** Meta's internal logs showed the inbound JSON payload was successfully received, but Render logs remained completely silent. No POST request ever reached the server.
**Root Cause:** Meta's Development Mode acts as a strict bouncer. It silently drops inbound messages if:
- The sender's phone number is not explicitly added to the "Test Phone Numbers" list.
- The message is sent outside the 24-hour customer service window (no prior outbound template message).
- The Webhook's "Phone Number ID" mapping in the Meta dashboard does not exactly match the number being texted.
**Resolution:**
- Implemented the "24-Hour Window Trick": Sent an "Order Confirmation" template to the user's phone to open the customer service window, then immediately replied.
- Verified the exact Phone Number ID (1354385164418436) mapping in the Meta Webhook configuration.

## Blocker #3: Render Free-Tier Spin-Down Timeout

**Symptom:** When testing after a period of inactivity, Meta logged the message, but Render showed no logs.
**Root Cause:** Render's free tier spins down the server after inactivity. Meta's webhook timeout is ~10-15 seconds, but Render takes ~50 seconds to wake up. Meta assumes the server is dead and drops the request.
**Resolution:** Implemented a "Wake-Up & Strike" protocol (using curl to ping the server before testing). Configured UptimeRobot to ping the server every 5 minutes to keep it warm.

## Blocker #4: Expired Meta Access Token (Silent Outbound Failure)

**Symptom: **The server successfully received the webhook (Webhook POST received), but the WhatsApp user never received the bot's reply.
**Root Cause:** Meta's temporary Access Token expires/disappears from the UI when navigating away. The server received the message but failed silently when trying to authenticate the outbound sendWhatsAppMessage API call.
**Resolution:** Regenerated the Access Token in Meta and updated the WHATSAPP_ACCESS_TOKEN environment variable in Render. Added error logging to the outbound message function.

## Blocker #5: Yarn Registry 404 Build Failure

**Symptom:** Render deployment failed with error Error: https://registry.yarnpkg.com/@supabase/storage-js/-/storage-js-2.117.1.tgz: Request failed "404 Not Found".
**Root Cause:** Yarn's package registry cache on Render temporarily failed to resolve a specific Supabase sub-dependency.
**Resolution:** Switched the Render Build and Start commands from yarn to npm install and npm start, which handled the registry resolution more robustly.

## Blocker #6: Database Schema Dependency Error

**Symptom:** Supabase SQL Editor returned ERROR: 42P01: relation "field_workers" does not exist.
**Root Cause:** The pickup_requests table was created before the field_workers table, but it contained a foreign key reference to field_workers.
**Resolution:** Reordered the SQL script to create field_workers first, followed by pickup_requests, and finally pickup_events.

## Blocker #7: Stale Webhook Callback URL

**Symptom:** After migrating to a new GitHub repository (grow-and-feeds-crm-backend), Meta showed the payload in its logs, but the new Render server received nothing.
**Root Cause:** The Callback URL in Meta was still pointing to the old repository's Render URL (grow-and-feeds-backend).
**Resolution: **Updated the Meta Webhook Callback URL to the exact new URL: https://grow-and-feeds-crm-backend.onrender.com/api/whatsapp/webhook.

## Current System Status

**Backend:** Live on Render (grow-and-feeds-crm-backend).
**Database:** Supabase PostgreSQL configured with pickup_requests, field_workers, and pickup_events.
**Integration:** Meta WhatsApp Cloud API webhook successfully verified and routing messages field.
**Workflow:** Conversational intake flow (Hi -> Name -> Waste Type -> Volume -> Location -> Confirmation) is fully operational.

## Future Mitigations (Next Increments)

- To prevent recurrence of these blockers in production, the following increments are planned:
- Persist Sessions: Move conversational state from in-memory Map to Supabase to survive Render restarts/spin-downs.
- Permanent Access Token: Transition from a temporary 24-hour Access Token to a permanent System User Access Token via Meta Business Manager.
- App Promotion: Move the Meta App from "Development Mode" to "Live Mode" to remove the 24-hour window and test-number restrictions.
- Uptime Monitoring: Maintain UptimeRobot integration to prevent Render free-tier spin-downs during operational hours.

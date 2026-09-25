import express from 'express';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Serves /public/dashboard.html at https://<your-render-url>/dashboard.html
app.use(express.static(path.join(__dirname, 'public')));

// Simple shared-secret check for the operator dashboard's API calls.
// Set DASHBOARD_API_KEY in Render's environment variables.
function requireDashboardKey(req, res, next) {
  const key = req.header('x-api-key');
  if (!process.env.DASHBOARD_API_KEY || key !== process.env.DASHBOARD_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---- Message de-duplication ----
// Meta can deliver the same event more than once (retries / multiple
// subscriptions). We keep a short-lived record of message IDs (wamid)
// we've already processed so a repeated delivery is a no-op.
const processedMessages = new Map(); // wamid -> timestamp
const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes

function isDuplicateMessage(id) {
  if (!id) return false;
  const now = Date.now();
  for (const [key, ts] of processedMessages) {
    if (now - ts > DEDUP_TTL_MS) processedMessages.delete(key);
  }
  if (processedMessages.has(id)) return true;
  processedMessages.set(id, now);
  return false;
}

// ---- Session persistence (Supabase-backed) ----
// Sessions used to live in an in-memory Map, which is wiped on every
// Render redeploy or free-tier spin-down. They now live in a `sessions`
// table so a patron's progress survives restarts.
async function getSession(phone) {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('phone', phone)
    .maybeSingle();

  if (error) {
    console.error('Supabase getSession error:', error);
    return { state: 'greeting' };
  }
  if (!data) return { state: 'greeting' };

  return {
    state: data.state,
    patron_name: data.patron_name ?? undefined,
    waste_type: data.waste_type ?? undefined,
    estimated_volume_kg: data.estimated_volume_kg ?? undefined,
    pickup_location: data.pickup_location ?? undefined
  };
}

async function setSession(phone, session) {
  const { error } = await supabase.from('sessions').upsert(
    {
      phone,
      state: session.state,
      patron_name: session.patron_name ?? null,
      waste_type: session.waste_type ?? null,
      estimated_volume_kg: session.estimated_volume_kg ?? null,
      pickup_location: session.pickup_location ?? null,
      updated_at: new Date().toISOString()
    },
    { onConflict: 'phone' }
  );
  if (error) console.error('Supabase setSession error:', error);
}

async function deleteSession(phone) {
  const { error } = await supabase.from('sessions').delete().eq('phone', phone);
  if (error) console.error('Supabase deleteSession error:', error);
}

function normalizePhone(phone) {
  const value = String(phone || '').replace(/\D/g, '');
  if (value.startsWith('254')) return value;
  if (value.startsWith('0') && value.length === 10) return `254${value.slice(1)}`;
  return value;
}

async function sendWhatsAppMessage(to, message) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  const response = await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'text',
      text: { body: message }
    })
  });
  return response.json();
}

// 1. META WEBHOOK VERIFICATION
app.get('/api/whatsapp/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('Webhook verified successfully');
    return res.status(200).send(challenge);
  }
  console.log('Verification failed');
  return res.sendStatus(403);
});

// 2. INCOMING WHATSAPP MESSAGES
app.post('/api/whatsapp/webhook', async (req, res) => {
  console.log('Webhook POST received at:', new Date().toISOString());

  try {
    const body = req.body;
    for (const entry of body?.entry || []) {
      for (const change of entry?.changes || []) {
        for (const message of change?.value?.messages || []) {
          const from = normalizePhone(message?.from);
          const text = message?.text?.body?.trim().toLowerCase();
          const messageId = message?.id;

          console.log('Parsed FROM:', from, 'Parsed TEXT:', text);

          if (isDuplicateMessage(messageId)) {
            console.log('Skipping duplicate delivery of message:', messageId);
            continue;
          }

          if (!from || !text) {
            console.log('Skipping payload: missing from or text');
            continue;
          }

          let session = await getSession(from);

          if (text === 'hi' || text === 'hello' || text === 'start') {
            session = { state: 'name' };
            await setSession(from, session);
            await sendWhatsAppMessage(from, "Welcome to Grow and Feeds Patrons.\n\nTo start a pickup request, please reply with your Name.");
            continue;
          }

          if (session.state === 'name') {
            session.patron_name = text;
            session.state = 'waste_type';
            await setSession(from, session);
            await sendWhatsAppMessage(from, `Thanks ${session.patron_name}.\n\nWhat type of organic waste do you have?\nReply with:\n1. fruit_veg\n2. crop_residue\n3. manure`);
            continue;
          }

          if (session.state === 'waste_type') {
            if (['fruit_veg', 'crop_residue', 'manure'].includes(text)) {
              session.waste_type = text;
              session.state = 'volume';
              await setSession(from, session);
              await sendWhatsAppMessage(from, `Great. You selected ${session.waste_type}.\n\nApproximately how many kilograms (kg) do you have? (Reply with a number, e.g., 50)`);
            } else {
              await sendWhatsAppMessage(from, "Please reply with exactly: fruit_veg, crop_residue, or manure.");
            }
            continue;
          }

          if (session.state === 'volume') {
            const volume = parseInt(text);
            if (isNaN(volume) || volume <= 0) {
              await sendWhatsAppMessage(from, "Please reply with a valid number greater than 0.");
              continue;
            }
            session.estimated_volume_kg = volume;
            session.state = 'location';
            await setSession(from, session);
            await sendWhatsAppMessage(from, "Got it. Where should we pick this up? (Reply with your location/address)");
            continue;
          }

          if (session.state === 'location') {
            session.pickup_location = text;
            session.state = 'confirmation';
            await setSession(from, session);

            const summary = `Please confirm your pickup request:\n\nName: ${session.patron_name}\nWaste: ${session.waste_type}\nVolume: ${session.estimated_volume_kg} kg\nLocation: ${session.pickup_location}\n\nReply YES to confirm or NO to cancel.`;
            await sendWhatsAppMessage(from, summary);
            continue;
          }

          if (session.state === 'confirmation') {
            if (text === 'no' || text === 'cancel') {
              await deleteSession(from);
              await sendWhatsAppMessage(from, "Request cancelled. Send 'Hi' to start over.");
              continue;
            }

            if (text === 'yes' || text === 'y') {
              const { error } = await supabase.from('pickup_requests').insert({
                patron_name: session.patron_name,
                patron_phone: from,
                waste_type: session.waste_type,
                estimated_volume_kg: session.estimated_volume_kg,
                pickup_location: session.pickup_location,
                status: 'pending'
              });

              if (error) {
                console.error('Supabase Insert Error:', error);
                await sendWhatsAppMessage(from, "We could not save your request right now. Please try again later.");
              } else {
                await sendWhatsAppMessage(from, "Request Confirmed! Our team will contact you shortly to arrange the pickup.");
              }

              await deleteSession(from);
              continue;
            }

            await sendWhatsAppMessage(from, "Please reply YES to confirm or NO to cancel.");
            continue;
          }

          if (session.state !== 'greeting') {
            await sendWhatsAppMessage(from, "It looks like our connection reset or I didn't understand. Please send 'Hi' to start a new request.");
            await deleteSession(from);
          }
        }
      }
    }
    return res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('Webhook Error:', error);
    return res.status(200).send('EVENT_RECEIVED');
  }
});

// ---- Operator Dashboard API ----

// Maps a status to the timestamp column it should stamp, if any.
function timestampForStatus(status) {
  if (status === 'assigned') return { assigned_at: new Date().toISOString() };
  if (status === 'collected') return { collected_at: new Date().toISOString() };
  if (status === 'processed') return { processed_at: new Date().toISOString() };
  return {};
}

async function logPickupEvent(requestId, status, notes) {
  const { error } = await supabase.from('pickup_events').insert({
    request_id: requestId,
    status,
    notes: notes ?? null
  });
  if (error) console.error('Supabase pickup_events insert error:', error);
}

// List all pickup requests, most recent first, with the assigned worker's details attached.
app.get('/api/pickup-requests', requireDashboardKey, async (req, res) => {
  const { data, error } = await supabase
    .from('pickup_requests')
    .select('*, field_workers(id, name, phone, status)')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// List field workers (for the dashboard's assignment dropdown).
app.get('/api/field-workers', requireDashboardKey, async (req, res) => {
  const { data, error } = await supabase
    .from('field_workers')
    .select('*')
    .order('name', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Add a new field worker.
app.post('/api/field-workers', requireDashboardKey, async (req, res) => {
  const name = (req.body?.name || '').trim();
  const phone = (req.body?.phone || '').trim();

  if (!name) return res.status(400).json({ error: 'name is required' });

  const { data, error } = await supabase
    .from('field_workers')
    .insert({ name, phone: phone || null, status: 'active' })
    .select()
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Assign a field worker to a request; moves it to 'assigned' and stamps assigned_at.
app.patch('/api/pickup-requests/:id/assign', requireDashboardKey, async (req, res) => {
  const { id } = req.params;
  const workerId = req.body?.worker_id;

  if (!workerId) {
    return res.status(400).json({ error: 'worker_id is required' });
  }

  const { data: worker, error: workerError } = await supabase
    .from('field_workers')
    .select('id, name')
    .eq('id', workerId)
    .maybeSingle();

  if (workerError) return res.status(500).json({ error: workerError.message });
  if (!worker) return res.status(404).json({ error: 'field worker not found' });

  const { data, error } = await supabase
    .from('pickup_requests')
    .update({
      worker_id: workerId,
      status: 'assigned',
      updated_at: new Date().toISOString(),
      ...timestampForStatus('assigned')
    })
    .eq('id', id)
    .select('*, field_workers(id, name, phone, status)')
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });

  await logPickupEvent(id, 'assigned', `Assigned to ${worker.name}`);
  res.json(data);
});

// Manually override a request's status; logs the change in pickup_events.
app.patch('/api/pickup-requests/:id/status', requireDashboardKey, async (req, res) => {
  const { id } = req.params;
  const { status, notes } = req.body || {};
  const allowed = ['pending', 'assigned', 'collected', 'processed', 'cancelled'];

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }

  const { data, error } = await supabase
    .from('pickup_requests')
    .update({
      status,
      updated_at: new Date().toISOString(),
      ...timestampForStatus(status)
    })
    .eq('id', id)
    .select('*, field_workers(id, name, phone, status)')
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });

  await logPickupEvent(id, status, notes);
  res.json(data);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Grow and Feeds Backend listening on port ${PORT}`);
});

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

app.use(express.static(path.join(__dirname, 'public')));

function requireDashboardKey(req, res, next) {
  const key = req.header('x-api-key');
  if (!process.env.DASHBOARD_API_KEY || key !== process.env.DASHBOARD_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const processedMessages = new Map();
const DEDUP_TTL_MS = 10 * 60 * 1000;

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

async function getSession(phone) {
  const { data, error } = await supabase.from('sessions').select('*').eq('phone', phone).maybeSingle();
  if (error) { console.error('Supabase getSession error:', error); return { state: 'greeting' }; }
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
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'text',
      text: { body: message }
    })
  });
  
     return await response.json();
}

async function sendWhatsAppAssignment(to, patronName, location, wasteType, volume, requestId) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  const bodyText = `NEW PICKUP ASSIGNED\n\nPatron: ${patronName}\nLocation: ${location}\nWaste: ${wasteType}\nVolume: ${volume} kg\n\nPlease tap a button to update status:`;

  try {
    const response = await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: bodyText },
          action: {
            buttons: [
              { type: 'reply', reply: { id: `collected_${requestId}`, title: 'Collected' } },
              { type: 'reply', reply: { id: `failed_${requestId}`, title: 'Not Picked' } }
            ]
          }
        }
      })
    });
    const result = await response.json();
    console.log('WhatsApp Assignment Sent:', result);
    return result;
  } catch (err) {
    console.error('Error sending WhatsApp assignment:', err);
  }
}

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

app.post('/api/whatsapp/webhook', async (req, res) => {
  console.log('Webhook POST received at:', new Date().toISOString());

  try {
    const body = req.body;
    for (const entry of body?.entry || []) {
      for (const change of entry?.changes || []) {
        for (const message of change?.value?.messages || []) {
          const from = normalizePhone(message?.from);
          const messageId = message?.id;

          if (isDuplicateMessage(messageId)) {
            console.log('Skipping duplicate delivery of message:', messageId);
            continue;
          }

          let text = '';
          let actionRequestId = null;
          let btnId = '';

          if (message?.type === 'interactive' && message?.interactive?.type === 'button_reply') {
            text = message?.interactive?.button_reply?.title?.trim().toLowerCase();
            btnId = message?.interactive?.button_reply?.id || '';
            if (btnId && btnId.includes('_')) {
              const parts = btnId.split('_');
              actionRequestId = parts.slice(1).join('_');
            }
          } else {
            text = message?.text?.body?.trim().toLowerCase();
          }

          if (!from || (!text && !actionRequestId)) {
            console.log('Skipping payload: missing from or text');
            continue;
          }

          if (actionRequestId) {
            console.log('Field worker action detected. Request:', actionRequestId, 'Action:', text);
            
            const { data: request, error: reqError } = await supabase
              .from('pickup_requests')
              .select('id, status, worker_id, field_workers(id, phone)')
              .eq('id', actionRequestId)
              .maybeSingle();

            if (reqError || !request) {
              console.error('Request not found for button action:', actionRequestId);
              return res.status(200).send('EVENT_RECEIVED');
            }

            const dbWorkerPhone = normalizePhone(request.field_workers?.phone);
            if (dbWorkerPhone !== from) {
              console.log('Security Alert: Phone mismatch. Expected:', dbWorkerPhone, 'Got:', from);
              await sendWhatsAppMessage(from, "SECURITY ALERT: You are not authorized to update this request.");
              return res.status(200).send('EVENT_RECEIVED');
            }

            let newStatus = request.status;
            let eventNotes = '';
            
            if (text.includes('collected') || btnId.startsWith('collected')) {
              if (request.status === 'assigned' || request.status === 'pending') {
                newStatus = 'collected';
                eventNotes = 'Field worker marked as collected via WhatsApp';
              }
            } else if (text.includes('not picked') || text.includes('failed') || btnId.startsWith('failed')) {
              if (request.status === 'assigned' || request.status === 'pending') {
                newStatus = 'cancelled';
                eventNotes = 'Field worker marked as not picked/cancelled via WhatsApp';
              }
            }

            if (newStatus !== request.status) {
              const { error: updateError } = await supabase
                .from('pickup_requests')
                .update({
                  status: newStatus,
                  updated_at: new Date().toISOString(),
                  ...(newStatus === 'assigned' ? { assigned_at: new Date().toISOString() } : {}),
                  ...(newStatus === 'collected' ? { collected_at: new Date().toISOString() } : {}),
                  ...(newStatus === 'processed' ? { processed_at: new Date().toISOString() } : {})
                })
                .eq('id', actionRequestId);

              if (updateError) {
                console.error('Failed to update request status:', updateError);
                await sendWhatsAppMessage(from, "FAILED TO UPDATE REQUEST. Please contact the operator.");
              } else {
                await logPickupEvent(actionRequestId, newStatus, eventNotes);

                if (request.worker_id) {
                  await supabase.from('field_workers').update({ status: 'available' }).eq('id', request.worker_id);
                }

                const confirmMsg = newStatus === 'collected' 
                  ? `SUCCESS: Pickup marked as COLLECTED.\n\nYou are now available for new assignments.`
                  : `NOTED: Pickup marked as CANCELLED.\n\nYou are now available for new assignments.`;
                await sendWhatsAppMessage(from, confirmMsg);
              }
            } else {
              await sendWhatsAppMessage(from, "INFO: This request is already in that status.");
            }
            
            return res.status(200).send('EVENT_RECEIVED');
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

app.get('/api/pickup-requests', requireDashboardKey, async (req, res) => {
  const { data, error } = await supabase
    .from('pickup_requests')
    .select('*, field_workers(id, name, phone, status)')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/field-workers', requireDashboardKey, async (req, res) => {
  const { data, error } = await supabase.from('field_workers').select('*').order('name', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/field-workers', requireDashboardKey, async (req, res) => {
  const name = (req.body?.name || '').trim();
  const phone = (req.body?.phone || '').trim();
  const service_area = (req.body?.service_area || '').trim();

  if (!name) return res.status(400).json({ error: 'name is required' });

  const { data, error } = await supabase
    .from('field_workers')
    .insert({ 
      name, 
      phone: phone || null, 
      service_area: service_area || null, 
      status: 'available' 
    })
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/pickup-requests/:id/assign', requireDashboardKey, async (req, res) => {
  const { id } = req.params;
  const workerId = req.body?.worker_id;

  if (!workerId) return res.status(400).json({ error: 'worker_id is required' });

  const { data: worker, error: workerError } = await supabase
    .from('field_workers')
    .select('id, name, phone, status')
    .eq('id', workerId)
    .maybeSingle();

  if (workerError) return res.status(500).json({ error: workerError.message });
  if (!worker) return res.status(404).json({ error: 'field worker not found' });
  if (worker.status !== 'available') return res.status(400).json({ error: 'Field worker is not available' });

  // ADDED: patron_phone to the select list
  const { data: request, error: reqError } = await supabase
    .from('pickup_requests')
    .select('patron_name, patron_phone, pickup_location, waste_type, estimated_volume_kg')
    .eq('id', id)
    .maybeSingle();

  if (reqError || !request) return res.status(404).json({ error: 'Pickup request not found' });

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
  await supabase.from('field_workers').update({ status: 'busy' }).eq('id', workerId);

  // 1. Send WhatsApp notification to the worker
  if (worker.phone) {
    await sendWhatsAppAssignment(
      normalizePhone(worker.phone),
      request.patron_name,
      request.pickup_location,
      request.waste_type,
      request.estimated_volume_kg,
      id
    );
  }

  // 2. ADDED: Send WhatsApp notification to the patron
  if (request.patron_phone) {
    const patronMessage = `Update: A collection team has been assigned to your request. They will contact you shortly to confirm the pickup time for your ${request.estimated_volume_kg}kg of ${request.waste_type}. Thank you for your patience.`;
    await sendWhatsAppMessage(request.patron_phone, patronMessage);
  }

  res.json(data);
});

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

  // ADDED: Two-Step Patron Transparency Notifications
  if (data?.patron_phone) {
    if (status === 'collected') {
      const receivedMessage = `Thank you. Your ${data.estimated_volume_kg}kg of ${data.waste_type} has been safely received at the Grow and Feeds facility. It is now entering the Black Soldier Fly processing cycle. We will notify you once the transformation is complete.`;
      await sendWhatsAppMessage(data.patron_phone, receivedMessage);
    }
    
    if (status === 'processed') {
      const processedMessage = `Great news! Your ${data.estimated_volume_kg}kg of ${data.waste_type} has been successfully transformed into Black Soldier Fly organic fertilizer and animal feed. Thank you for contributing to a greener environment and supporting sustainable agriculture with Grow and Feeds Patrons.`;
      await sendWhatsAppMessage(data.patron_phone, processedMessage);
    }
  }

  res.json(data);
});
// SMART DISPATCH: Auto-assign a worker based on service area matching
app.post('/api/pickup-requests/:id/auto-assign', requireDashboardKey, async (req, res) => {
  const { id } = req.params;

  // 1. Get the pickup request details
  const { data: request, error: reqError } = await supabase
    .from('pickup_requests')
    .select('id, patron_name, patron_phone, pickup_location, waste_type, estimated_volume_kg, status')
    .eq('id', id)
    .maybeSingle();

  if (reqError || !request) return res.status(404).json({ error: 'Pickup request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });

  // 2. Find an available worker whose service area matches the pickup location
  // We use ilike for case-insensitive partial matching (e.g., "Nairobi West" matches "nairobi west")
  const { data: matchedWorker, error: matchError } = await supabase
    .from('field_workers')
    .select('*')
    .eq('status', 'available')
    .ilike('service_area', `%${request.pickup_location}%`)
    .maybeSingle();

  // 3. Fallback: If no area match, find ANY available worker
  let finalWorker = matchedWorker;
  let assignmentType = 'Area Match';
  
  if (!finalWorker) {
    const { data: fallbackWorker } = await supabase
      .from('field_workers')
      .select('*')
      .eq('status', 'available')
      .maybeSingle();
    finalWorker = fallbackWorker;
    assignmentType = 'Fallback (No area match)';
  }

  if (!finalWorker) {
    return res.status(400).json({ error: 'No available workers found in the system' });
  }

  // 4. Perform the assignment (update request and worker status)
  const { data: updatedRequest, error: updateError } = await supabase
    .from('pickup_requests')
    .update({
      worker_id: finalWorker.id,
      status: 'assigned',
      updated_at: new Date().toISOString(),
      assigned_at: new Date().toISOString()
    })
    .eq('id', id)
    .select('*, field_workers(id, name, phone, status)')
    .maybeSingle();

  if (updateError) return res.status(500).json({ error: updateError.message });

  // 5. Mark worker as busy
  await supabase.from('field_workers').update({ status: 'busy' }).eq('id', finalWorker.id);

  // 6. Log the event
  await logPickupEvent(id, 'assigned', `Auto-assigned to ${finalWorker.name} via ${assignmentType}`);

    // 7. Send WhatsApp notification to the worker
  if (finalWorker.phone) {
    await sendWhatsAppAssignment(
      normalizePhone(finalWorker.phone),
      request.patron_name,
      request.pickup_location,
      request.waste_type,
      request.estimated_volume_kg,
      id
    );
  }

  // 8. ADDED: Send WhatsApp notification to the patron
  if (request.patron_phone) {
    const patronMessage = `Update: A collection team has been automatically assigned to your request. They will contact you shortly to confirm the pickup time for your ${request.estimated_volume_kg}kg of ${request.waste_type}. Thank you for your patience.`;
    await sendWhatsAppMessage(request.patron_phone, patronMessage);
  }

  res.json({ success: true, worker: finalWorker.name, assignmentType });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Grow and Feeds Backend listening on port ${PORT}`);
});

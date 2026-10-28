import express from 'express';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { OpenAI } from 'openai';

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

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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

function capitalizeName(name) {
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

function getVehicleType(kg) {
  if (kg <= 500) return 'Pickup Truck';
  if (kg <= 2000) return 'Mini Truck';
  return 'Trailer';
}

function calculateMPesaCost(kg, distanceKm = 15) {
  const baseRate = 50;
  return Math.ceil((kg * 0.5) + (distanceKm * baseRate));
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
    pickup_location: data.pickup_location ?? undefined,
    vehicle_type: data.vehicle_type ?? undefined
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
      vehicle_type: session.vehicle_type ?? null,
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

async function sendWhatsAppAssignment(to, patronName, location, wasteType, volume, vehicleType, requestId) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  const bodyText = `NEW PICKUP ASSIGNED\n\nPatron: ${patronName}\nLocation: ${location}\nWaste: ${wasteType}\nVolume: ${volume} kg\nVehicle Required: ${vehicleType}\n\nPlease tap a button to update status:`;

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
              { type: 'reply', reply: { id: `picked_${requestId}`, title: 'Picked Up' } },
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
  console.log('1. Webhook POST received at:', new Date().toISOString());

  try {
    const body = req.body;
    for (const entry of body?.entry || []) {
      for (const change of entry?.changes || []) {
        for (const message of change?.value?.messages || []) {
          const from = normalizePhone(message?.from);
          const messageId = message?.id;

          if (isDuplicateMessage(messageId)) continue;

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
            text = message?.text?.body?.trim();
          }

          if (!from || (!text && !actionRequestId)) continue;

          if (actionRequestId) {
            const { data: request, error: reqError } = await supabase
              .from('pickup_requests')
              .select('id, status, worker_id, patron_phone, estimated_volume_kg, waste_type, field_workers(id, phone)')
              .eq('id', actionRequestId)
              .maybeSingle();
            
            if (reqError || !request) return res.status(200).send('EVENT_RECEIVED');

            const dbWorkerPhone = normalizePhone(request.field_workers?.phone);
            if (dbWorkerPhone !== from) {
              await sendWhatsAppMessage(from, "SECURITY ALERT: You are not authorized to update this request.");
              return res.status(200).send('EVENT_RECEIVED');
            }

            let newStatus = request.status;
            let eventNotes = '';
            
            if (text.includes('picked') || btnId.startsWith('picked')) {
              if (request.status === 'assigned') {
                newStatus = 'collected';
                eventNotes = 'Driver marked as Picked Up via WhatsApp';
                await sendWhatsAppMessage(request.patron_phone, `Thank you ${request.patron_name}! Your ${request.estimated_volume_kg}kg of waste has been successfully picked up. You are contributing to a cleaner Nairobi and supporting organic farming. We will notify you once it reaches our facility.`);
                await sendWhatsAppMessage(from, "Great job! Please enter the Waste ID Number issued at the facility drop-off gate:");
                await supabase.from('sessions').upsert({ phone: from, state: 'driver_waste_id', request_id: actionRequestId }, { onConflict: 'phone' });
                return res.status(200).send('EVENT_RECEIVED');
              }
            } else if (text.includes('not picked') || text.includes('failed') || btnId.startsWith('failed')) {
              if (request.status === 'assigned') {
                newStatus = 'cancelled';
                eventNotes = 'Driver marked as Not Picked via WhatsApp';
              }
            }

            if (newStatus !== request.status) {
              const { error: updateError } = await supabase.from('pickup_requests').update({
                status: newStatus, updated_at: new Date().toISOString(),
                ...(newStatus === 'collected' ? { collected_at: new Date().toISOString() } : {})
              }).eq('id', actionRequestId);

              if (updateError) {
                await sendWhatsAppMessage(from, "FAILED TO UPDATE REQUEST.");
              } else {
                await logPickupEvent(actionRequestId, newStatus, eventNotes);
                if (request.worker_id) await supabase.from('field_workers').update({ status: 'available' }).eq('id', request.worker_id);
                const confirmMsg = newStatus === 'collected' ? `SUCCESS: Pickup marked. You are now available.` : `NOTED: Pickup cancelled. You are now available.`;
                await sendWhatsAppMessage(from, confirmMsg);
              }
            }
            return res.status(200).send('EVENT_RECEIVED');
          }

          let session = await getSession(from);

          if (session.state === 'driver_waste_id') {
            const wasteId = text.trim();
            await supabase.from('pickup_requests').update({ waste_id: wasteId, delivered_to_facility: true, processed_at: new Date().toISOString() }).eq('id', session.request_id);
            await deleteSession(from);
            
            const patronMsg = `Great news! Your waste has been safely received at our facility and the Black Soldier Fly transformation has begun. \n\nIn 3 weeks, we'll tell you when the larvae are harvested. In 7 weeks, we'll let you know when your waste becomes rich organic fertilizer. Thank you for growing more and feeding better!`;
            const { data: reqData } = await supabase.from('pickup_requests').select('patron_phone').eq('id', session.request_id).single();
            if(reqData) await sendWhatsAppMessage(reqData.patron_phone, patronMsg);
            await sendWhatsAppMessage(from, `Waste ID ${wasteId} recorded successfully. Payment for your service has been initiated.`);
            return res.status(200).send('EVENT_RECEIVED');
          }

          if (text.toLowerCase() === 'hi' || text.toLowerCase() === 'hello' || text.toLowerCase() === 'hey') {
            session = { state: 'name' };
            await setSession(from, session);
            await sendWhatsAppMessage(from, "Welcome to Grow and Feeds Patrons.\n\nTo start a pickup request, please reply with your Name.");
            continue;
          }

          if (session.state === 'name') {
            const capitalizedName = capitalizeName(text);
            session.patron_name = capitalizedName;
            session.state = 'waste_type';
            await setSession(from, session);
            await sendWhatsAppMessage(from, `Thanks ${capitalizedName}.\n\nWhat type of organic waste do you have? Reply with a number (e.g., 1):\n\n1. Processing & Packaging (Factory peels, trimmings, byproducts)\n2. Market & Retail Organic Waste (Expired produce, unsold stock)\n3. Restaurants & Hotels (Cooked scraps, prep waste)\n4. Households (Kitchen scraps)\n5. Agriculture & Farms (Crop residues, manure)\n6. Schools & Institutions (Bulk organic waste)`);
            continue;
          }

          if (session.state === 'waste_type') {
            const wasteMap = {
              '1': 'processing', 'processing': 'processing', '1.': 'processing',
              '2': 'market', 'market': 'market', '2.': 'market',
              '3': 'restaurant', 'restaurant': 'restaurant', '3.': 'restaurant',
              '4': 'household', 'household': 'household', '4.': 'household',
              '5': 'agriculture', 'agriculture': 'agriculture', '5.': 'agriculture',
              '6': 'institutional', 'institutional': 'institutional', '6.': 'institutional'
            };
            const cleanInput = text.toLowerCase().replace('.', '').trim();
            const mappedWaste = wasteMap[cleanInput] || wasteMap[text.toLowerCase()];

            if (mappedWaste) {
              session.waste_type = mappedWaste;
              session.state = 'volume';
              await setSession(from, session);
              await sendWhatsAppMessage(from, "Great. Approximately how many kilograms (kg) do you have? (Reply with a number, e.g., 50)");
            } else {
              await sendWhatsAppMessage(from, "Please reply with a valid number (1-6).");
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
            session.vehicle_type = getVehicleType(volume);
            session.state = 'location';
            await setSession(from, session);
            await sendWhatsAppMessage(from, `Got it. For ${volume}kg, we will assign a ${session.vehicle_type}.\n\nWhere should we pick this up? (Reply with your location/address or share your live location)`);
            continue;
          }

          if (session.state === 'location') {
            session.pickup_location = text;
            session.state = 'confirmation';
            await setSession(from, session);
            const cost = calculateMPesaCost(session.estimated_volume_kg);
            const summary = `Please confirm your pickup request:\n\nName: ${session.patron_name}\nWaste: ${session.waste_type}\nVolume: ${session.estimated_volume_kg} kg\nVehicle: ${session.vehicle_type}\nLocation: ${session.pickup_location}\n\nEstimated Cost: KES ${cost}\n\nReply YES to confirm and receive the M-Pesa payment prompt.`;
            await sendWhatsAppMessage(from, summary);
            continue;
          }

          if (session.state === 'confirmation') {
            if (text.toLowerCase() === 'no' || text.toLowerCase() === 'cancel') {
              await deleteSession(from);
              await sendWhatsAppMessage(from, "Request cancelled. Send 'Hi' to start over.");
              continue;
            }
            if (text.toLowerCase() === 'yes' || text.toLowerCase() === 'y') {
              await sendWhatsAppMessage(from, "Request Confirmed! Kindly enter your M-Pesa PIN on the prompt that has just appeared on your screen to pay for organic waste disposal services.");
              
              setTimeout(async () => {
                const { error } = await supabase.from('pickup_requests').insert({
                  patron_name: session.patron_name,
                  patron_phone: from,
                  waste_type: session.waste_type,
                  estimated_volume_kg: session.estimated_volume_kg,
                  pickup_location: session.pickup_location,
                  vehicle_type: session.vehicle_type,
                  payment_received: true,
                  status: 'pending'
                });
                
                if (!error) {
                  await sendWhatsAppMessage(from, "Payment received successfully! A collection team will be assigned shortly. You will receive the vehicle and driver details soon.");
                }
              }, 2000);

              await deleteSession(from);
              continue;
            }
            await sendWhatsAppMessage(from, "Please reply YES to confirm or NO to cancel.");
            continue;
          }

          const aiReply = await getAIResponse(text);
          if (aiReply) await sendWhatsAppMessage(from, aiReply);
          else await sendWhatsAppMessage(from, "I did not understand that. Please send 'Hi' to start a new pickup request.");
          if (session.state !== 'greeting') await deleteSession(from);
        }
      }
    }
    return res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('99. CRITICAL Webhook Error:', error);
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
  const { error } = await supabase.from('pickup_events').insert({ request_id: requestId, status, notes: notes ?? null });
  if (error) console.error('Supabase pickup_events insert error:', error);
}

const qwenClient = new OpenAI({ baseURL: 'https://api-inference.modelscope.ai/v1', apiKey: process.env.QWEN_API_KEY });
async function getAIResponse(userMessage) {
  try {
    const response = await qwenClient.chat.completions.create({
      model: 'Qwen-Ambassador/Qwen3.7-Max',
      messages: [{ role: 'system', content: 'You are a helpful assistant for Grow and Feeds Patrons. Keep answers under 300 characters.' }, { role: 'user', content: userMessage }],
      temperature: 0.7, max_tokens: 150
    });
    return response.choices[0].message.content;
  } catch (error) { return null; }
}

// ===== DASHBOARD API ENDPOINTS =====

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
    .insert({ name, phone: phone || null, service_area: service_area || null, status: 'available' })
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

  const { data: request, error: reqError } = await supabase
    .from('pickup_requests')
    .select('patron_name, patron_phone, pickup_location, waste_type, estimated_volume_kg, worker_id')
    .eq('id', id)
    .maybeSingle();

  if (reqError || !request) return res.status(404).json({ error: 'Pickup request not found' });

  if (request.worker_id && request.worker_id !== workerId) {
    await supabase.from('field_workers').update({ status: 'available' }).eq('id', request.worker_id);
    await logPickupEvent(id, 'reassigned', `Reassigned from previous worker to ${worker.name}`);
  } else {
    await logPickupEvent(id, 'assigned', `Assigned to ${worker.name}`);
  }

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

  await supabase.from('field_workers').update({ status: 'busy' }).eq('id', workerId);

  if (worker.phone) {
    await sendWhatsAppAssignment(
      normalizePhone(worker.phone),
      request.patron_name,
      request.pickup_location,
      request.waste_type,
      request.estimated_volume_kg,
      request.vehicle_type || 'Pickup Truck',
      id
    );
  }

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

app.post('/api/pickup-requests/:id/auto-assign', requireDashboardKey, async (req, res) => {
  const { id } = req.params;

  const { data: request, error: reqError } = await supabase
    .from('pickup_requests')
    .select('id, patron_name, patron_phone, pickup_location, waste_type, estimated_volume_kg, status, vehicle_type')
    .eq('id', id)
    .maybeSingle();

  if (reqError || !request) return res.status(404).json({ error: 'Pickup request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });

  const { data: matchedWorker, error: matchError } = await supabase
    .from('field_workers')
    .select('*')
    .eq('status', 'available')
    .ilike('service_area', `%${request.pickup_location}%`)
    .maybeSingle();

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

  await supabase.from('field_workers').update({ status: 'busy' }).eq('id', finalWorker.id);

  await logPickupEvent(id, 'assigned', `Auto-assigned to ${finalWorker.name} via ${assignmentType}`);

  if (finalWorker.phone) {
    await sendWhatsAppAssignment(
      normalizePhone(finalWorker.phone),
      request.patron_name,
      request.pickup_location,
      request.waste_type,
      request.estimated_volume_kg,
      request.vehicle_type || 'Pickup Truck',
      id
    );
  }

  if (request.patron_phone) {
    const patronMessage = `Update: A collection team has been automatically assigned to your request. They will contact you shortly to confirm the pickup time for your ${request.estimated_volume_kg}kg of ${request.waste_type}. Thank you for your patience.`;
    await sendWhatsAppMessage(request.patron_phone, patronMessage);
  }

  res.json({ success: true, worker: finalWorker.name, assignmentType });
});

app.get('/api/reports/weekly-impact', requireDashboardKey, async (req, res) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const isoSevenDaysAgo = sevenDaysAgo.toISOString();

    const { data, error } = await supabase
      .from('pickup_requests')
      .select('estimated_volume_kg, waste_type, pickup_location, status')
      .in('status', ['collected', 'processed'])
      .gte('created_at', isoSevenDaysAgo);

    if (error) return res.status(500).json({ error: error.message });

    if (!data || data.length === 0) {
      return res.json({ report: "No completed pickups found in the last 7 days. Keep up the great outreach to local farmers and vendors!" });
    }

    const totalKg = data.reduce((sum, row) => sum + (row.estimated_volume_kg || 0), 0);
    const wasteTypes = {};
    const locations = {};
    
    data.forEach(row => {
      wasteTypes[row.waste_type] = (wasteTypes[row.waste_type] || 0) + (row.estimated_volume_kg || 0);
      locations[row.pickup_location] = (locations[row.pickup_location] || 0) + 1;
    });

    const topLocation = Object.keys(locations).reduce((a, b) => locations[a] > locations[b] ? a : b);
    const topWaste = Object.keys(wasteTypes).reduce((a, b) => wasteTypes[a] > wasteTypes[b] ? a : b);

    const promptData = `
      Total completed pickups: ${data.length}
      Total weight diverted: ${totalKg} kg
      Top waste type: ${topWaste} (${wasteTypes[topWaste]} kg)
      Most active location: ${topLocation} (${locations[topLocation]} pickups)
    `;

    const qwenResponse = await qwenClient.chat.completions.create({
      model: 'Qwen-Ambassador/Qwen3.7-Max',
      messages: [
        {
          role: 'system',
          content: 'You are an operational analyst for Grow and Feeds Patrons, a Kenyan agribusiness converting organic waste into Black Soldier Fly (BSF) fertilizer and animal feed. Write a short, inspiring, professional weekly impact report (under 150 words) based on the provided data. Highlight the environmental impact (e.g., diverting waste from landfills, reducing methane emissions, supporting circular agriculture). Use a professional, encouraging tone.'
        },
        {
          role: 'user',
          content: `Generate a weekly impact report based on this operational data:\n${promptData}`
        }
      ],
      temperature: 0.7,
      max_tokens: 250
    });

    res.json({ report: qwenResponse.choices[0].message.content });
  } catch (error) {
    console.error('AI Report Generation Error:', error);
    res.status(500).json({ error: 'Failed to generate AI report' });
  }
});

app.patch('/api/pickup-requests/:id/update', requireDashboardKey, async (req, res) => {
  const { id } = req.params;
  const { payment_received, delivered_to_facility, delivery_facility } = req.body || {};

  const updateData = { updated_at: new Date().toISOString() };
  if (payment_received !== undefined) updateData.payment_received = payment_received;
  if (delivered_to_facility !== undefined) updateData.delivered_to_facility = delivered_to_facility;
  if (delivery_facility !== undefined) updateData.delivery_facility = delivery_facility;

  const { data, error } = await supabase
    .from('pickup_requests')
    .update(updateData)
    .eq('id', id)
    .select('*, field_workers(id, name, phone, status)')
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Grow and Feeds Backend listening on port ${PORT}`);
});

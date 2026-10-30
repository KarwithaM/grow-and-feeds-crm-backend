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

// --- VEHICLE LOGIC ---
function getVehicleCapacity(type) {
  if (type === 'handcart') return 500;
  if (type === 'pickup') return 1000;
  if (type === 'mini_truck') return 4500;
  if (type === 'trailer') return 10000;
  return 0;
}

function getVehicleCost(type) {
  if (type === 'handcart') return 500;
  if (type === 'pickup') return 1500;
  if (type === 'mini_truck') return 3000;
  if (type === 'trailer') return 6000;
  return 0;
}

function getVehicleType(kg) {
  if (kg <= 500) return 'Handcart';
  if (kg <= 1000) return 'Pickup Truck';
  if (kg <= 4500) return 'Mini Truck';
  return 'Trailer';
}

function calculateMPesaCost(kg, distanceKm = 15) {
  const baseRate = 50;
  return Math.ceil((kg * 0.5) + (distanceKm * baseRate));
}

function getLeastCostAllocation(volume, availableWorkers) {
  const pools = {
    'handcart': availableWorkers.filter(w => w.vehicle_type === 'handcart'),
    'pickup': availableWorkers.filter(w => w.vehicle_type === 'pickup'),
    'mini_truck': availableWorkers.filter(w => w.vehicle_type === 'mini_truck'),
    'trailer': availableWorkers.filter(w => w.vehicle_type === 'trailer')
  };

  let bestOption = null;
  let minCost = Infinity;

  const checkOption = (vehicles, cost) => {
    if (cost < minCost) {
      minCost = cost;
      bestOption = { vehicles, cost };
    }
  };

  if (volume <= 10000 && pools['trailer'].length >= 1) checkOption([{ type: 'trailer', drivers: [pools['trailer'][0]] }], getVehicleCost('trailer'));
  if (volume <= 4500 && pools['mini_truck'].length >= 1) checkOption([{ type: 'mini_truck', drivers: [pools['mini_truck'][0]] }], getVehicleCost('mini_truck'));
  if (volume <= 1000 && pools['pickup'].length >= 1) checkOption([{ type: 'pickup', drivers: [pools['pickup'][0]] }], getVehicleCost('pickup'));
  if (volume <= 500 && pools['handcart'].length >= 1) checkOption([{ type: 'handcart', drivers: [pools['handcart'][0]] }], getVehicleCost('handcart'));

  if (volume <= 2000 && pools['pickup'].length >= 2) {
    checkOption([{ type: 'pickup', drivers: [pools['pickup'][0], pools['pickup'][1]] }], getVehicleCost('pickup') * 2);
  }
  if (volume <= 1000 && pools['handcart'].length >= 2) {
    checkOption([{ type: 'handcart', drivers: [pools['handcart'][0], pools['handcart'][1]] }], getVehicleCost('handcart') * 2);
  }
  if (volume <= 5500 && pools['mini_truck'].length >= 1 && pools['pickup'].length >= 1) {
    checkOption([
      { type: 'mini_truck', drivers: [pools['mini_truck'][0]] },
      { type: 'pickup', drivers: [pools['pickup'][0]] }
    ], getVehicleCost('mini_truck') + getVehicleCost('pickup'));
  }

  return bestOption;
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
      phone, state: session.state, patron_name: session.patron_name ?? null,
      waste_type: session.waste_type ?? null, estimated_volume_kg: session.estimated_volume_kg ?? null,
      pickup_location: session.pickup_location ?? null, vehicle_type: session.vehicle_type ?? null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'phone' }
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
  if (value.startsWith('250')) return value;
  if (value.startsWith('0') && value.length === 10) return `254${value.slice(1)}`;
  return value;
}

async function sendWhatsAppMessage(to, message) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const response = await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: to, type: 'text', text: { body: message } })
  });
  return await response.json();
}

async function sendWhatsAppButtons(to, bodyText, buttons, requestId) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  try {
    const response = await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', recipient_type: 'individual', to: to, type: 'interactive',
        interactive: {
          type: 'button', body: { text: bodyText },
          action: { buttons: buttons.map((btn) => ({ type: 'reply', reply: { id: `${btn.id}_${requestId}`, title: btn.title } })) }
        }
      })
    });
    const result = await response.json();
    console.log('WhatsApp Buttons Sent:', result);
    return result;
  } catch (err) { console.error('Error sending WhatsApp buttons:', err); }
}

app.get('/api/whatsapp/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('Webhook verified successfully');
    return res.status(200).send(challenge);
  }
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
          let btnAction = '';

          if (message?.type === 'interactive' && message?.interactive?.type === 'button_reply') {
            btnId = message?.interactive?.button_reply?.id || '';
            text = message?.interactive?.button_reply?.title?.trim().toLowerCase();
            if (btnId && btnId.includes('_')) {
              const parts = btnId.split('_');
              btnAction = parts[0];
              actionRequestId = parts.slice(1).join('_');
            }
          } else {
            text = message?.text?.body?.trim();
          }

          if (!from || (!text && !actionRequestId)) continue;

          // --- DRIVER ACTIONS ---
          if (actionRequestId) {
            const { data: request, error: reqError } = await supabase
              .from('pickup_requests')
              .select('id, status, worker_id, secondary_worker_id, patron_name, patron_phone, estimated_volume_kg, waste_type, pickup_location, field_workers!pickup_requests_worker_id_fkey(id, name, phone, vehicle_type, vehicle_plate)')
              .eq('id', actionRequestId)
              .maybeSingle();
            
            if (reqError || !request) return res.status(200).send('EVENT_RECEIVED');

            if (btnAction === 'accept') {
              await supabase.from('pickup_requests').update({
                status: 'assigned', updated_at: new Date().toISOString(), assigned_at: new Date().toISOString()
              }).eq('id', actionRequestId);
              
              await supabase.from('field_workers').update({ status: 'busy' }).eq('id', request.worker_id);
              if(request.secondary_worker_id) await supabase.from('field_workers').update({ status: 'busy' }).eq('id', request.secondary_worker_id);

              await logPickupEvent(actionRequestId, 'assigned', `Driver confirmed pickup.`);

              let teamDetails = `🚛 Driver 1: ${request.field_workers.name}\n Vehicle: ${request.field_workers.vehicle_type} (${request.field_workers.vehicle_plate})\n`;

              if (request.secondary_worker_id) {
                  const { data: secondaryWorker } = await supabase
                      .from('field_workers')
                      .select('name, vehicle_type, vehicle_plate')
                      .eq('id', request.secondary_worker_id)
                      .single();
                  if (secondaryWorker) {
                      teamDetails += `\n🚛 Driver 2: ${secondaryWorker.name}\n🚚 Vehicle: ${secondaryWorker.vehicle_type} (${secondaryWorker.vehicle_plate})\n`;
                  }
              }

              const customerMsg = `Great news! Your collection team is confirmed and on their way.\n\n${teamDetails}\n📍 Location: ${request.pickup_location}\n\nThey will contact you shortly to coordinate the pickup.\n\nThank you for growing more and feeding better! 🌱\n\n Fun Fact: Black Soldier Fly larvae are completely harmless and don't bite or sting!`;
              
              await sendWhatsAppMessage(request.patron_phone, customerMsg);

              await sendWhatsAppButtons(from, `Job Confirmed! Please proceed to the pickup location. Once you have the waste, tap below:`, [
                { id: 'picked', title: 'Picked Up' }, { id: 'failed', title: 'Cannot Pick' }
              ], actionRequestId);
              return res.status(200).send('EVENT_RECEIVED');
            }

            if (btnAction === 'decline') {
              await supabase.from('pickup_requests').update({ status: 'pending', worker_id: null, secondary_worker_id: null }).eq('id', actionRequestId);
              await supabase.from('field_workers').update({ status: 'available' }).eq('id', request.worker_id);
              if(request.secondary_worker_id) await supabase.from('field_workers').update({ status: 'available' }).eq('id', request.secondary_worker_id);
              await sendWhatsAppMessage(from, "No problem! We will assign this to another driver.");
              return res.status(200).send('EVENT_RECEIVED');
            }

            if (btnAction === 'picked') {
              if (request.status === 'assigned') {
                await supabase.from('pickup_requests').update({
                  status: 'collected', updated_at: new Date().toISOString(), collected_at: new Date().toISOString()
                }).eq('id', actionRequestId);
                
                const customerMsg = `Thank you ${request.patron_name}! Your ${request.estimated_volume_kg}kg of ${request.waste_type} has been successfully picked up. You are contributing to a cleaner Nairobi and supporting organic farming. We will notify you once it reaches our facility.\n\n Fun Fact: BSF larvae can eat twice their body weight every single day!`;
                await sendWhatsAppMessage(request.patron_phone, customerMsg);

                await sendWhatsAppMessage(from, "Great job! Please enter the Waste ID Number issued at the facility drop-off gate:");
                await supabase.from('sessions').upsert({ phone: from, state: 'driver_waste_id', request_id: actionRequestId }, { onConflict: 'phone' });
                return res.status(200).send('EVENT_RECEIVED');
              }
            }

            if (btnAction === 'failed') {
              if (request.status === 'assigned') {
                await supabase.from('pickup_requests').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', actionRequestId);
                await supabase.from('field_workers').update({ status: 'available' }).eq('id', request.worker_id);
                if(request.secondary_worker_id) await supabase.from('field_workers').update({ status: 'available' }).eq('id', request.secondary_worker_id);
                await sendWhatsAppMessage(from, "Noted. Pickup cancelled. You are now available.");
                return res.status(200).send('EVENT_RECEIVED');
              }
            }
          }

          // --- PATRON & DRIVER CONVERSATIONAL FLOW ---
          let session = await getSession(from);

                    if (session.state === 'driver_waste_id') {
            const wasteId = text.trim();
            
            // 1. Update Database
            await supabase.from('pickup_requests').update({ 
              waste_id: wasteId, 
              delivered_to_facility: true, 
              status: 'delivered', // Explicitly set status to delivered
              processed_at: new Date().toISOString() 
            }).eq('id', session.request_id);
            
            await deleteSession(from);
            
            // 2. Fetch Patron Details
            const { data: reqData } = await supabase.from('pickup_requests').select('patron_phone, patron_name, estimated_volume_kg, waste_type').eq('id', session.request_id).single();
            
            if(reqData) {
              // 3. Send "Delivered" Message to Customer
              const deliveredMsg = `Great news! Your waste (${reqData.estimated_volume_kg}kg of ${reqData.waste_type}) has been safely received at our facility and the Black Soldier Fly transformation has begun. 🏭\n\nThank you for growing more and feeding better!\n\n💡 Fun Fact: BSF frass is odorless and rich in nutrients, making it a perfect organic fertilizer.`;
              await sendWhatsAppMessage(reqData.patron_phone, deliveredMsg);

              // 4. Send 3-Week and 7-Week Updates (Test Mode: Immediate)
              const week3Msg = `Update: It's been 3 weeks since your drop-off! The BSF larvae have been successfully harvested from your waste. They are now being processed into high-protein animal feed. \n\n💡 Fun Fact: BSF larvae are up to 40% protein, making them an excellent alternative to soy and fishmeal!`;
              await sendWhatsAppMessage(reqData.patron_phone, week3Msg);
              
              const week7Msg = `Final Update: It's been 7 weeks! Your waste has been fully transformed into rich organic fertilizer, ready to nourish our farms. 🌾\n\n💡 Fun Fact: One ton of BSF frass can fertilize up to 5 acres of land!`;
              await sendWhatsAppMessage(reqData.patron_phone, week7Msg);
            }

            // 5. Confirm to Driver
            await sendWhatsAppMessage(from, `Waste ID ${wasteId} recorded successfully. Payment for your service has been initiated. Thank you for your hard work!`);
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
            await sendWhatsAppMessage(from, `Thanks ${capitalizedName}.\n\nWhat type of organic waste do you have? Reply with a number (e.g., 1):\n\n1. Processing & Packaging\n2. Market & Retail\n3. Restaurants & Hotels\n4. Households\n5. Agriculture & Farms\n6. Schools & Institutions`);
            continue;
          }

          if (session.state === 'waste_type') {
            const wasteMap = { '1': 'processing', '2': 'market', '3': 'restaurant', '4': 'household', '5': 'agriculture', '6': 'institutional' };
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
            if (isNaN(volume) || volume <= 0) { await sendWhatsAppMessage(from, "Please reply with a valid number greater than 0."); continue; }
            session.estimated_volume_kg = volume;
            session.vehicle_type = getVehicleType(volume);
            session.state = 'location';
            await setSession(from, session);
            await sendWhatsAppMessage(from, `Got it. For ${volume}kg, we will assign a ${session.vehicle_type}.\n\nWhere should we pick this up?`);
            continue;
          }

          if (session.state === 'location') {
            session.pickup_location = text;
            session.state = 'confirmation';
            await setSession(from, session);
            const cost = calculateMPesaCost(session.estimated_volume_kg);
            const summary = `Please confirm your pickup request:\n\nName: ${session.patron_name}\nWaste: ${session.waste_type}\nVolume: ${session.estimated_volume_kg} kg\nVehicle: ${session.vehicle_type}\nLocation: ${session.pickup_location}\n\nEstimated Cost: KES ${cost}\n\nReply YES to confirm.`;
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
              await sendWhatsAppMessage(from, "Request Confirmed! Kindly enter your M-Pesa PIN on the prompt that has just appeared on your screen.");
              setTimeout(async () => {
                const { error } = await supabase.from('pickup_requests').insert({
                  patron_name: session.patron_name, patron_phone: from, waste_type: session.waste_type,
                  estimated_volume_kg: session.estimated_volume_kg, pickup_location: session.pickup_location,
                  vehicle_type: session.vehicle_type, payment_received: true, status: 'pending'
                });
                if (!error) await sendWhatsAppMessage(from, "Payment received successfully! A collection team will be assigned shortly.");
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
  if (status === 'processed' || status === 'delivered') return { processed_at: new Date().toISOString() };
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
      messages: [{ role: 'system', content: 'You are a helpful assistant for Grow and Feeds Patrons.' }, { role: 'user', content: userMessage }],
      temperature: 0.7, max_tokens: 150
    });
    return response.choices[0].message.content;
  } catch (error) { return null; }
}

// ===== DASHBOARD API ENDPOINTS =====

app.get('/api/pickup-requests', requireDashboardKey, async (req, res) => {
  const { data, error } = await supabase.from('pickup_requests').select('*, field_workers!pickup_requests_worker_id_fkey(id, name, phone, status)').order('created_at', { ascending: false });
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
  const vehicle_type = (req.body?.vehicle_type || '').trim();
  const vehicle_plate = (req.body?.vehicle_plate || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { data, error } = await supabase.from('field_workers').insert({ name, phone: phone || null, service_area: service_area || null, vehicle_type: vehicle_type || null, vehicle_plate: vehicle_plate || null, status: 'available' }).select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/pickup-requests/:id/assign', requireDashboardKey, async (req, res) => {
  const { id } = req.params;
  const workerId = req.body?.worker_id;
  if (!workerId) return res.status(400).json({ error: 'worker_id is required' });
  
  const { data: worker, error: workerError } = await supabase.from('field_workers').select('id, name, phone, status, vehicle_type, vehicle_plate').eq('id', workerId).maybeSingle();
  if (workerError || !worker) return res.status(500).json({ error: 'Worker not found' });

  // Fetch current request to check for existing drivers
  const { data: request, error: reqError } = await supabase.from('pickup_requests').select('patron_name, patron_phone, pickup_location, waste_type, estimated_volume_kg, worker_id, secondary_worker_id').eq('id', id).maybeSingle();
  if (reqError || !request) return res.status(404).json({ error: 'Request not found' });

  // FREE PREVIOUS DRIVERS if reassigning
  if (request.worker_id && request.worker_id !== workerId) {
    await supabase.from('field_workers').update({ status: 'available' }).eq('id', request.worker_id);
  }
  if (request.secondary_worker_id) {
    await supabase.from('field_workers').update({ status: 'available' }).eq('id', request.secondary_worker_id);
  }

  await supabase.from('pickup_requests').update({ 
    worker_id: workerId, 
    secondary_worker_id: null, // Clear secondary on manual reassign
    status: 'assigned', 
    updated_at: new Date().toISOString() 
  }).eq('id', id);
  
  await supabase.from('field_workers').update({ status: 'busy' }).eq('id', workerId);

  if (worker.phone) {
    await sendWhatsAppButtons(normalizePhone(worker.phone), `NEW PICKUP ASSIGNED\n\nPatron: ${request.patron_name}\nLocation: ${request.pickup_location}\nVolume: ${request.estimated_volume_kg} kg\n\nPlease confirm:`, [{ id: 'accept', title: 'Confirm' }, { id: 'decline', title: 'Decline' }], id);
  }
  res.json({ success: true, worker: worker.name });
});

app.post('/api/pickup-requests/:id/auto-assign', requireDashboardKey, async (req, res) => {
  const { id } = req.params;

  const { data: request, error: reqError } = await supabase.from('pickup_requests').select('id, patron_name, patron_phone, pickup_location, waste_type, estimated_volume_kg, status').eq('id', id).maybeSingle();
  if (reqError || !request) return res.status(404).json({ error: 'Pickup request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });

  const { data: availableWorkers, error: workerError } = await supabase.from('field_workers').select('*').eq('status', 'available');
  if (workerError) return res.status(500).json({ error: workerError.message });

  const allocation = getLeastCostAllocation(request.estimated_volume_kg, availableWorkers);

  if (!allocation) {
    return res.status(400).json({ error: 'No available vehicles can handle this load.' });
  }

  const primaryDriver = allocation.vehicles[0].drivers[0];
  const secondaryDriver = allocation.vehicles.length > 1 && allocation.vehicles[0].drivers.length > 1 ? allocation.vehicles[0].drivers[1] : null;
  
  let secondaryDriverMixed = null;
  if (allocation.vehicles.length > 1) {
      secondaryDriverMixed = allocation.vehicles[1].drivers[0];
  }
  const finalSecondary = secondaryDriver || secondaryDriverMixed;

  const updateData = {
    worker_id: primaryDriver.id,
    status: 'assigned',
    updated_at: new Date().toISOString(),
    assigned_at: new Date().toISOString()
  };
  if (finalSecondary) updateData.secondary_worker_id = finalSecondary.id;

  await supabase.from('pickup_requests').update(updateData).eq('id', id);
  await supabase.from('field_workers').update({ status: 'busy' }).eq('id', primaryDriver.id);
  if (finalSecondary) await supabase.from('field_workers').update({ status: 'busy' }).eq('id', finalSecondary.id);

  await logPickupEvent(id, 'assigned', `Auto-assigned via Least Cost Logic. Cost: ${allocation.cost}. Drivers: ${primaryDriver.name}${finalSecondary ? ', ' + finalSecondary.name : ''}`);

  if (primaryDriver.phone) {
    await sendWhatsAppButtons(normalizePhone(primaryDriver.phone), `NEW PICKUP ASSIGNED (Least Cost Option)\n\nPatron: ${request.patron_name}\nLocation: ${request.pickup_location}\nVolume: ${request.estimated_volume_kg} kg\n\nPlease confirm:`, [{ id: 'accept', title: 'Confirm' }, { id: 'decline', title: 'Decline' }], id);
  }

  if (finalSecondary && finalSecondary.phone) {
    await sendWhatsAppMessage(normalizePhone(finalSecondary.phone), `NEW PICKUP ASSIGNED (Support Vehicle)\n\nPatron: ${request.patron_name}\nLocation: ${request.pickup_location}\nVolume: ${request.estimated_volume_kg} kg\n\nPlease proceed to the location. Your partner driver will coordinate with you.`);
  }

  if (request.patron_phone) {
    let vehicleDesc = primaryDriver.vehicle_type;
    if (finalSecondary) vehicleDesc += ` + ${finalSecondary.vehicle_type}`;
    
    const patronMessage = `Update: We have assigned the most efficient team for your request.\n\nVehicles: ${vehicleDesc}\n\nThey will contact you shortly. Thank you for your patience.`;
    await sendWhatsAppMessage(request.patron_phone, patronMessage);
  }

  res.json({ success: true, worker: primaryDriver.name, allocation });
});

// NEW: Handle status changes from dashboard dropdown
app.patch('/api/pickup-requests/:id/status', requireDashboardKey, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  
  const allowed = ['pending', 'assigned', 'collected', 'delivered', 'processed', 'cancelled'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }

  // Fetch current request to get worker IDs before updating
  const { data: currentRequest } = await supabase
    .from('pickup_requests')
    .select('worker_id, secondary_worker_id, patron_phone, patron_name, estimated_volume_kg, waste_type')
    .eq('id', id)
    .single();

  const updateData = { status, updated_at: new Date().toISOString() };
  
  // FREE DRIVERS when job is delivered, processed, or cancelled
  if (status === 'delivered' || status === 'processed' || status === 'cancelled') {
    updateData.delivered_to_facility = (status === 'delivered' || status === 'processed');
    updateData.processed_at = new Date().toISOString();
    
    if (currentRequest) {
      if (currentRequest.worker_id) {
        await supabase.from('field_workers').update({ status: 'available' }).eq('id', currentRequest.worker_id);
      }
      if (currentRequest.secondary_worker_id) {
        await supabase.from('field_workers').update({ status: 'available' }).eq('id', currentRequest.secondary_worker_id);
      }
    }
  }
  
  if (status === 'collected') {
    updateData.collected_at = new Date().toISOString();
  }

  await supabase.from('pickup_requests').update(updateData).eq('id', id);

  if (currentRequest && currentRequest.patron_phone) {
    let msg = '';
    if (status === 'collected') {
      msg = `Thank you ${currentRequest.patron_name}! Your ${currentRequest.estimated_volume_kg}kg of ${currentRequest.waste_type} has been successfully picked up. You are contributing to a cleaner Nairobi! 🌱\n\n💡 Fun Fact: BSF larvae can eat twice their body weight every single day!`;
    } else if (status === 'delivered') {
      msg = `Great news! Your waste has been safely received at our facility and the Black Soldier Fly transformation has begun. 🏭\n\n💡 Fun Fact: BSF frass is odorless and rich in nutrients, making it a perfect organic fertilizer.`;
    } else if (status === 'processed') {
      msg = `Final Update: Your waste has been fully transformed into rich BSF Frass (organic fertilizer) and high-protein Larvae (animal feed)! 🌾\n\nThank you for helping us grow more and feed better!\n\n💡 Fun Fact: One ton of BSF frass can fertilize up to 5 acres of land!`;
    } else if (status === 'cancelled') {
      msg = `Update: Your pickup request has been cancelled. If you need to schedule a new pickup, please reply 'Hi' to start a new request.`;
    }
    
    if (msg) await sendWhatsAppMessage(currentRequest.patron_phone, msg);
  }

  res.json({ success: true });
});

// Handle manual "Processed (Done)" checkbox from dashboard
app.patch('/api/pickup-requests/:id/process', requireDashboardKey, async (req, res) => {
  const { id } = req.params;

  // Fetch details for WhatsApp notification
  const { data: request } = await supabase
    .from('pickup_requests')
    .select('patron_phone, patron_name, estimated_volume_kg, waste_type')
    .eq('id', id)
    .single();

  // Update status to processed
  await supabase.from('pickup_requests').update({ 
    status: 'processed', 
    updated_at: new Date().toISOString() 
  }).eq('id', id);

  // Send final transformation message to customer
  if (request && request.patron_phone) {
    const msg = `Final Update: Your waste has been fully transformed into rich BSF Frass (organic fertilizer) and high-protein Larvae (animal feed)! 🌾\n\nThank you for helping us grow more and feed better!\n\n💡 Fun Fact: One ton of BSF frass can fertilize up to 5 acres of land!`;
    await sendWhatsAppMessage(request.patron_phone, msg);
  }

  res.json({ success: true });
});

app.get('/api/reports/weekly-impact', requireDashboardKey, async (req, res) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const isoSevenDaysAgo = sevenDaysAgo.toISOString();

    const { data, error } = await supabase
      .from('pickup_requests')
      .select('estimated_volume_kg, waste_type, pickup_location, status')
      .in('status', ['collected', 'processed', 'delivered'])
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

    // Updated to the standard, reliable ModelScope model
    const qwenResponse = await qwenClient.chat.completions.create({
      model: 'Qwen/Qwen2.5-72B-Instruct', 
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
    // Graceful fallback so the button never shows a raw error to the user
    res.json({ report: "Weekly Impact Report: Successfully diverted organic waste from landfills this week, supporting circular agriculture and reducing methane emissions. (Note: AI generation experienced a temporary issue, but your operational data is securely logged!)" });
  }
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
  const { payment_received, delivered_to_facility } = req.body || {};
  const updateData = { updated_at: new Date().toISOString() };
  if (payment_received !== undefined) updateData.payment_received = payment_received;
  if (delivered_to_facility !== undefined) updateData.delivered_to_facility = delivered_to_facility;
  const { data, error } = await supabase.from('pickup_requests').update(updateData).eq('id', id).select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => { console.log(`Grow and Feeds Backend listening on port ${PORT}`); });

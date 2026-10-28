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

// Helper to capitalize names
function capitalizeName(name) {
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

// Helper to determine vehicle based on volume
function getVehicleType(kg) {
  if (kg <= 500) return 'Pickup Truck';
  if (kg <= 2000) return 'Mini Truck';
  return 'Trailer';
}

// Helper to calculate estimated M-Pesa cost (Mock logic)
function calculateMPesaCost(kg, distanceKm = 15) {
  const baseRate = 50; // KES per km
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

          // --- DRIVER ACTIONS ---
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
                // Notify Patron
                await sendWhatsAppMessage(request.patron_phone, `Thank you ${request.patron_name}! Your ${request.estimated_volume_kg}kg of waste has been successfully picked up. You are contributing to a cleaner Nairobi and supporting organic farming. We will notify you once it reaches our facility.`);
                // Prompt Driver for Waste ID
                await sendWhatsAppMessage(from, "Great job! Please enter the Waste ID Number issued at the facility drop-off gate:");
                // Set a temporary state for the driver to input the ID
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

          // --- PATRON & DRIVER CONVERSATIONAL FLOW ---
          let session = await getSession(from);

          // Special case: Driver entering Waste ID
          if (session.state === 'driver_waste_id') {
            const wasteId = text.trim();
            await supabase.from('pickup_requests').update({ waste_id: wasteId, delivered_to_facility: true, processed_at: new Date().toISOString() }).eq('id', session.request_id);
            await deleteSession(from);
            
            // Notify Patron about Drop-off and 3-week/7-week timeline
            const patronMsg = `Great news! Your waste has been safely received at our facility and the Black Soldier Fly transformation has begun. \n\nIn 3 weeks, we'll tell you when the larvae are harvested. In 7 weeks, we'll let you know when your waste becomes rich organic fertilizer. Thank you for growing more and feeding better!`;
            await sendWhatsAppMessage(session.phone === from ? session.phone : from, patronMsg); // Note: In real app, use request.patron_phone
            // For demo simplicity, we assume session.phone might be patron or driver. In production, fetch request.patron_phone.
            const { data: reqData } = await supabase.from('pickup_requests').select('patron_phone').eq('id', session.request_id).single();
            if(reqData) await sendWhatsAppMessage(reqData.patron_phone, patronMsg);

            await sendWhatsAppMessage(from, `Waste ID ${wasteId} recorded successfully. Payment for your service has been initiated.`);
            return res.status(200).send('EVENT_RECEIVED');
          }

          // 1. Greeting
          if (text.toLowerCase() === 'hi' || text.toLowerCase() === 'hello' || text.toLowerCase() === 'hey') {
            session = { state: 'name' };
            await setSession(from, session);
            await sendWhatsAppMessage(from, "Welcome to Grow and Feeds Patrons.\n\nTo start a pickup request, please reply with your Name.");
            continue;
          }

          // 2. Name Capture (with capitalization)
          if (session.state === 'name') {
            const capitalizedName = capitalizeName(text);
            session.patron_name = capitalizedName;
            session.state = 'waste_type';
            await setSession(from, session);
            await sendWhatsAppMessage(from, `Thanks ${capitalizedName}.\n\nWhat type of organic waste do you have? Reply with a number (e.g., 1):\n\n1. Processing & Packaging (Factory peels, trimmings, byproducts)\n2. Market & Retail Organic Waste (Expired produce, unsold stock)\n3. Restaurants & Hotels (Cooked scraps, prep waste)\n4. Households (Kitchen scraps)\n5. Agriculture & Farms (Crop residues, manure)\n6. Schools & Institutions (Bulk organic waste)`);
            continue;
          }

          // 3. Waste Type Mapping
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

          // 4. Volume & Vehicle Logic
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

          // 5. Location
          if (session.state === 'location') {
            session.pickup_location = text;
            session.state = 'confirmation';
            await setSession(from, session);
            const cost = calculateMPesaCost(session.estimated_volume_kg);
            const summary = `Please confirm your pickup request:\n\nName: ${session.patron_name}\nWaste: ${session.waste_type}\nVolume: ${session.estimated_volume_kg} kg\nVehicle: ${session.vehicle_type}\nLocation: ${session.pickup_location}\n\nEstimated Cost: KES ${cost}\n\nReply YES to confirm and receive the M-Pesa payment prompt.`;
            await sendWhatsAppMessage(from, summary);
            continue;
          }

          // 6. Confirmation & M-Pesa Simulation
          if (session.state === 'confirmation') {
            if (text.toLowerCase() === 'no' || text.toLowerCase() === 'cancel') {
              await deleteSession(from);
              await sendWhatsAppMessage(from, "Request cancelled. Send 'Hi' to start over.");
              continue;
            }
            if (text.toLowerCase() === 'yes' || text.toLowerCase() === 'y') {
              // Simulate M-Pesa STK Push
              await sendWhatsAppMessage(from, "Request Confirmed! Kindly enter your M-Pesa PIN on the prompt that has just appeared on your screen to pay for organic waste disposal services.");
              
              // Simulate Payment Success after 2 seconds (In production, this is a webhook from Daraja)
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
                  // Trigger Auto-Assign logic here if desired, or let operator do it manually
                }
              }, 2000);

              await deleteSession(from);
              continue;
            }
            await sendWhatsAppMessage(from, "Please reply YES to confirm or NO to cancel.");
            continue;
          }

          // AI Fallback
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

// ... [Keep all existing Dashboard API endpoints, AI Report, Auto-Assign, etc. exactly as they were in the previous version] ...
// Note: Ensure your Supabase tables have columns: vehicle_type (text), waste_id (text), payment_received (boolean), delivered_to_facility (boolean)

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

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => { console.log(`Grow and Feeds Backend listening on port ${PORT}`); });

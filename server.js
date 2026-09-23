import express from 'express';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

// Initialize Supabase (Persistent operational source of truth)
const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// In-memory session store for conversational state (Section 18: Current Limitations)
const sessions = new Map();

// Helper: Normalize phone numbers to prevent formatting mismatches (Section 9.2)
function normalizePhone(phone) {
  const value = String(phone || '').replace(/\D/g, '');
  if (value.startsWith('254')) return value;
  if (value.startsWith('0') && value.length === 10) return `254${value.slice(1)}`;
  return value;
}

// Helper: Send text messages back to the user via WhatsApp Cloud API (Section 12)
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

// 1. META WEBHOOK VERIFICATION (Section 17: Observability & Health Checks)
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

// 2. INCOMING WHATSAPP MESSAGES (Section 8: Customer WhatsApp Workflow)
app.post('/api/whatsapp/webhook', async (req, res) => {
  // Observability log
  console.log('Webhook POST received at:', new Date().toISOString());

  try {
    const body = req.body;
    for (const entry of body?.entry || []) {
      for (const change of entry?.changes || []) {
        for (const message of change?.value?.messages || []) {
          const from = normalizePhone(message?.from);
          const text = message?.text?.body?.trim().toLowerCase();
          
          if (!from || !text) continue;

          // Retrieve or initialize session
          let session = sessions.get(from) || { state: 'greeting' };

          // State Machine Logic
          if (text === 'hi' || text === 'hello' || text === 'start') {
            session = { state: 'name' };
            sessions.set(from, session);
            await sendWhatsAppMessage(from, "Welcome to Grow and Feeds Patrons.\n\nTo start a pickup request, please reply with your Name.");
            continue;
          }

          if (session.state === 'name') {
            session.patron_name = text;
            session.state = 'waste_type';
            sessions.set(from, session);
            await sendWhatsAppMessage(from, `Thanks ${session.patron_name}.\n\nWhat type of organic waste do you have?\nReply with:\n1. fruit_veg\n2. crop_residue\n3. manure`);
            continue;
          }

          if (session.state === 'waste_type') {
            if (['fruit_veg', 'crop_residue', 'manure'].includes(text)) {
              session.waste_type = text;
              session.state = 'volume';
              sessions.set(from, session);
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
            sessions.set(from, session);
            await sendWhatsAppMessage(from, "Got it. Where should we pick this up? (Reply with your location/address)");
            continue;
          }

          if (session.state === 'location') {
            session.pickup_location = text;
            session.state = 'confirmation';
            sessions.set(from, session);
            
            const summary = `Please confirm your pickup request:\n\nName: ${session.patron_name}\nWaste: ${session.waste_type}\nVolume: ${session.estimated_volume_kg} kg\nLocation: ${session.pickup_location}\n\nReply YES to confirm or NO to cancel.`;
            await sendWhatsAppMessage(from, summary);
            continue;
          }

          if (session.state === 'confirmation') {
            if (text === 'no' || text === 'cancel') {
              sessions.delete(from);
              await sendWhatsAppMessage(from, "Request cancelled. Send 'Hi' to start over.");
              continue;
            }
            
            if (text === 'yes' || text === 'y') {
              // Save to Supabase (Section 5: Data Model)
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
              
              // Reset session
              sessions.delete(from);
              continue;
            }
            
            await sendWhatsAppMessage(from, "Please reply YES to confirm or NO to cancel.");
            continue;
          }

          // Fallback for lost sessions or unrecognized commands
          if (session.state !== 'greeting') {
             await sendWhatsAppMessage(from, "It looks like our connection reset or I didn't understand. Please send 'Hi' to start a new request.");
             sessions.delete(from);
          }
        }
      }
    }
    return res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('Webhook Error:', error);
    return res.status(200).send('EVENT_RECEIVED'); // Always return 200 to Meta
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Grow and Feeds Backend listening on port ${PORT}`);
});

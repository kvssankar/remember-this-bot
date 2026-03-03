const dbUtil = require('./utils/dbUtil');
const whatsappUtil = require('./utils/whatsappUtil');
const telegramUtil = require('./utils/telegramUtil');
const aiService = require('./services/aiService');
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");

const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

const INTERIM_MESSAGES = [
  "Thinking...",
  "Let me check that for you...",
  "Hang on a second, just peeking inside that link...",
  "Processing... this might take a moment.",
  "Give me a few seconds to look into this.",
  "Searching my memory banks...",
  "Almost there, just finalizing the details.",
  "One moment, I'm analyzing the information.",
  "Still working on it, hang tight!",
  "Digging up the details for you..."
];

// Configuration from Environment Variables
const CONFIG = {
  META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN,
  PROCESSOR_FUNCTION_NAME: process.env.PROCESSOR_FUNCTION_NAME || 'WhatsAppProcessor'
};

/**
 * Main Webhook Handler (Entry Point)
 * GOAL: Respond 200 OK as fast as possible.
 */
exports.handler = async (event) => {
  console.log('Webhook Received:', JSON.stringify(event, null, 2));

  // 1. WhatsApp Webhook Verification (GET)
  if (event.requestContext?.http?.method === 'GET' || event.httpMethod === 'GET') {
    const params = event.queryStringParameters;
    if (params?.['hub.mode'] === 'subscribe' && params?.['hub.verify_token'] === CONFIG.META_VERIFY_TOKEN) {
      return { statusCode: 200, body: params?.['hub.challenge'], headers: { 'Content-Type': 'text/plain' } };
    }
    return { statusCode: 403, body: 'Verification failed' };
  }

  // 2. Handle Incoming Messages (POST)
  if (event.requestContext?.http?.method === 'POST' || event.httpMethod === 'POST') {
    try {
      // TRIGGER ASYNC PROCESSOR
      const command = new InvokeCommand({
        FunctionName: CONFIG.PROCESSOR_FUNCTION_NAME,
        InvocationType: 'Event', // <--- Asynchronous (Fire and Forget)
        Payload: JSON.stringify(event),
      });

      await lambdaClient.send(command);
      console.log('Async processor triggered. Returning 200 OK to platform.');

      return { statusCode: 200, body: 'Accepted' };
    } catch (error) {
      console.error('Error triggering processor:', error);
      return { statusCode: 200, body: 'Error Acknowledged' };
    }
  }

  return { statusCode: 404, body: 'Not Found' };
};

/**
 * Worker Handler (Heavy Lifting)
 * Triggered asynchronously by the main handler.
 */
exports.processorHandler = async (event) => {
  console.log('Processor Started:', JSON.stringify(event, null, 2));
  
  let platform, id, isProcessable = false;
  try {
    const body = JSON.parse(event.body || '{}');

    // Detect Platform and User ID
    if (body.object === 'whatsapp_business_account') {
      const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (msg && (msg.type === 'text' || msg.type === 'image')) {
        platform = 'wa';
        id = msg.from;
        isProcessable = true;
      }
    } else if (body.update_id && body.message) {
      if (body.message.text || body.message.photo) {
        platform = 'tg';
        id = body.message.chat.id.toString();
        isProcessable = true;
      }
    }

    let timer7, timer35;
    if (isProcessable && platform && id) {
      // 7-second timer: Random "Thinking" message
      timer7 = setTimeout(async () => {
        const msg = INTERIM_MESSAGES[Math.floor(Math.random() * INTERIM_MESSAGES.length)];
        console.log(`[Interim] Sending 7s update to ${id}: ${msg}`);
        if (platform === 'wa') await whatsappUtil.sendMessage(id, msg);
        else await telegramUtil.sendMessage(id, `_${msg}_`);
      }, 7000);

      // 35-second timer: "Processing in BG" message
      timer35 = setTimeout(async () => {
        const msg = "This is taking a bit longer than expected. ⏳ I'm still processing your request in the background, and it will be saved shortly!";
        console.log(`[Interim] Sending 35s update to ${id}`);
        if (platform === 'wa') await whatsappUtil.sendMessage(id, msg);
        else await telegramUtil.sendMessage(id, `_${msg}_`);
      }, 35000);
    }

    try {
      if (body.object === 'whatsapp_business_account') {
        await handleWhatsApp(body);
      } else if (body.update_id) {
        await handleTelegram(body);
      }
    } catch (innerError) {
      console.error('Inner logic error:', innerError);
      if (isProcessable && platform && id) {
        const errorMsg = "Something went wrong while processing your request. Please try again in a moment. 🛠️";
        if (platform === 'wa') await whatsappUtil.sendMessage(id, errorMsg);
        else await telegramUtil.sendMessage(id, errorMsg);
      }
    } finally {
      if (timer7) clearTimeout(timer7);
      if (timer35) clearTimeout(timer35);
    }

  } catch (error) {
    console.error('Fatal error in processorHandler:', error);
  }
};

/**
 * Handle Telegram Messages
 */
async function handleTelegram(body) {
  const message = body.message;
  if (!message) return;

  const chatId = message.chat.id.toString();
  const from = `tg_${chatId}`;
  const userName = message.from.first_name || "User";
  const messageTimestamp = message.date ? message.date * 1000 : Date.now();

  const dailyCount = await dbUtil.getDailyMessageCount(from);
  if (dailyCount >= 100) {
    await telegramUtil.sendMessage(chatId, "⚠️ Daily message limit reached.");
    return;
  }

  // Handle Photo
  if (message.photo) {
    const photo = message.photo[message.photo.length - 1];
    const { data, mimeType } = await telegramUtil.downloadFile(photo.file_id);
    const caption = message.caption || "";

    const { aiResponse } = await aiService.processImage(from, data, mimeType, caption, messageTimestamp, userName);
    const aiResponseText = typeof aiResponse === 'string' ? aiResponse : JSON.stringify(aiResponse);
    
    await dbUtil.saveMessage(from, { role: 'user', type: 'image', content: `[Image]: ${caption}` });
    await telegramUtil.sendMessage(chatId, aiResponseText);
    await dbUtil.saveMessage(from, { role: 'assistant', type: 'text', content: aiResponseText });
    return;
  }

  // Handle Text
  if (message.text) {
    const userContent = message.text;
    await dbUtil.saveMessage(from, { role: 'user', type: 'text', content: userContent });
    const history = await dbUtil.getRecentMessages(from, 10);
    const aiResponse = await aiService.processMessage(from, userContent, history, messageTimestamp, userName);

    await telegramUtil.sendMessage(chatId, aiResponse);
    await dbUtil.saveMessage(from, { role: 'assistant', type: 'text', content: aiResponse });
  }
}

/**
 * Handle WhatsApp Messages
 */
async function handleWhatsApp(body) {
  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];

  if (!message) return;

  const fromRaw = message.from;
  const from = `wa_${fromRaw}`;
  const userName = value?.contacts?.[0]?.profile?.name || "User";
  const messageTimestamp = message.timestamp ? parseInt(message.timestamp) * 1000 : Date.now();

  const dailyCount = await dbUtil.getDailyMessageCount(from);
  if (dailyCount >= 100) return;

  if (message.type === 'image') {
    const { data, mimeType } = await whatsappUtil.downloadMedia(message.image.id);
    const caption = message.image.caption || "";
    
    const { aiResponse } = await aiService.processImage(from, data, mimeType, caption, messageTimestamp, userName);
    const aiResponseText = typeof aiResponse === 'string' ? aiResponse : JSON.stringify(aiResponse);
    
    await dbUtil.saveMessage(from, { role: 'user', type: 'image', content: `[Image]: ${caption}` });
    await whatsappUtil.sendMessage(fromRaw, aiResponseText);
    await dbUtil.saveMessage(from, { role: 'assistant', type: 'text', content: aiResponseText });
  } 
  else if (message.type === 'text') {
    const userContent = message.text.body;
    await dbUtil.saveMessage(from, { role: 'user', type: 'text', content: userContent });
    const history = await dbUtil.getRecentMessages(from, 10);
    const aiResponse = await aiService.processMessage(from, userContent, history, messageTimestamp, userName);

    await whatsappUtil.sendMessage(fromRaw, aiResponse);
    await dbUtil.saveMessage(from, { role: 'assistant', type: 'text', content: aiResponse });
  }
}

/**
 * Reminder Handler
 */
exports.reminderHandler = async (event) => {
  console.log('Running Reminder Handler...');
  try {
    const isMorningRun = event.type === 'morning';
    const isEveningRun = event.type === 'evening';

    if (isMorningRun || isEveningRun) {
      const now = new Date();
      const istOffset = 5.5 * 60 * 60 * 1000;
      const istNow = new Date(now.getTime() + istOffset);
      let startISO, endISO, timeframe;

      if (isMorningRun) {
        const todayStart = new Date(istNow); todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(istNow); todayEnd.setHours(23, 59, 59, 999);
        startISO = new Date(todayStart.getTime() - istOffset).toISOString();
        endISO = new Date(todayEnd.getTime() - istOffset).toISOString();
        timeframe = "Today";
      } else {
        const tomorrowEnd = new Date(istNow); tomorrowEnd.setDate(istNow.getDate() + 1); tomorrowEnd.setHours(23, 59, 59, 999);
        startISO = now.toISOString();
        endISO = new Date(tomorrowEnd.getTime() - istOffset).toISOString();
        timeframe = "Today and Tomorrow";
      }

      const reminders = await dbUtil.getRemindersInRange(startISO, endISO);
      if (reminders.length === 0) return { statusCode: 200, body: 'No reminders' };

      const userReminders = reminders.reduce((acc, r) => {
        acc[r.userId] = acc[r.userId] || [];
        acc[r.userId].push(r);
        return acc;
      }, {});

      for (const [userId, items] of Object.entries(userReminders)) {
        const [platform, id] = userId.split('_');
        const summary = await aiService.consolidateReminders(items, "User", timeframe);
        if (summary) {
          if (platform === 'wa') await whatsappUtil.sendMessage(id, summary);
          else if (platform === 'tg') await telegramUtil.sendMessage(id, summary);
        }
      }
      return { statusCode: 200, body: 'Done' };
    }

    const dueReminders = await dbUtil.getDueReminders();
    for (const reminder of dueReminders) {
      const message = `🚨 *Reminder*: ${reminder.title}\n\n${reminder.content}`;
      const [platform, id] = reminder.userId.split('_');
      if (platform === 'wa') await whatsappUtil.sendMessage(id, message);
      else if (platform === 'tg') await telegramUtil.sendMessage(id, message);
      await dbUtil.updateNoteStatus(reminder.userId, reminder.noteId, 'reminded');
    }
    return { statusCode: 200, body: 'Done' };
  } catch (error) {
    console.error('Error in reminderHandler:', error);
    throw error;
  }
};

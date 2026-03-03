const { ChatBedrockConverse } = require("@langchain/aws");
const { StateGraph, Annotation, messagesStateReducer } = require("@langchain/langgraph");
const { ToolNode } = require("@langchain/langgraph/prebuilt");
const { HumanMessage, SystemMessage, AIMessage } = require("@langchain/core/messages");
const { tool } = require("@langchain/core/tools");
const { z } = require("zod");
const dbUtil = require("../utils/dbUtil");
const searchUtil = require("../utils/searchUtil");

// Helper for URL metadata
async function getUrlMetadata(text) {
  let browser;
  const timeoutMs = 15000; // 15 seconds total timeout for Puppeteer
  
  // Create a promise that rejects after the timeout
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Puppeteer metadata extraction timed out')), timeoutMs);
  });

  try {
    const getUrls = (await import('get-urls')).default;
    const puppeteer = require('puppeteer-core');
    const chromium = require('@sparticuz/chromium');
    
    const urls = [...getUrls(text)];
    if (urls.length === 0) return null;

    console.log(`[Metadata] Found ${urls.length} URLs, fetching metadata via Puppeteer (Lambda-ready, 15s timeout)...`);
    const results = [];
    
    // Wrap the entire fetching process with the timeout
    const fetchMetadata = async () => {
      browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      });

      for (const url of urls) {
        try {
          const page = await browser.newPage();
          await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
          
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 12000 }); // 12s per URL
          
          const meta = await page.evaluate(() => {
            const getMeta = (prop) => document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`)?.getAttribute('content');
            return {
              title: getMeta('og:title') || getMeta('twitter:title') || document.title,
              description: getMeta('og:description') || getMeta('twitter:description') || getMeta('description'),
              siteName: getMeta('og:site_name') || getMeta('twitter:site') || null
            };
          });
          
          results.push({
            url,
            title: meta.title,
            description: meta.description,
            siteName: meta.siteName
          });
          
          await page.close();
        } catch (err) {
          console.error(`[Metadata] Error for ${url}:`, err.message);
        }
      }
      return results.length > 0 ? results : null;
    };

    // Race the fetching process against the timeout
    return await Promise.race([fetchMetadata(), timeoutPromise]);

  } catch (err) {
    console.error(`[Metadata] ${err.message}`);
    return null;
  } finally {
    if (browser) {
      console.log("[Metadata] Closing browser instance...");
      // Fire and forget closure to prevent blocking the return on timeout
      browser.close().catch(closeErr => console.error("[Metadata] Error closing browser:", closeErr.message));
    }
  }
}

const model = new ChatBedrockConverse({
  model: process.env.BEDROCK_MODEL_ID,
  region: process.env.AWS_REGION || "us-east-1",
  temperature: 0,
});

// Module-level context variables
let contextUserId = null;
let contextUserName = null;

// Tool Schemas
const saveNoteSchema = z.object({ 
  title: z.string().describe("Note title"), 
  content: z.string().describe("Note content"), 
  category: z.string().describe("Category"), 
  tags: z.array(z.string()).describe("Tags"), 
  reminderDate: z.string().optional().describe("Reminder date in YYYY-MM-DD format (ISO 8601). Mandatory if the user asks for a reminder today/tomorrow/etc.")
});

const saveHouseNoteSchema = z.object({ 
  title: z.string().describe("Note title"), 
  content: z.string().describe("Note content"), 
  category: z.string().describe("Category"), 
  tags: z.array(z.string()).describe("Tags")
});

const searchSchema = z.object({ query: z.string().describe("Search query") });
const listByCategorySchema = z.object({ category: z.string().describe("Category name to filter by") });

// Tools
const saveNoteTool = tool(async (args) => {
  console.log(`[Tool] save_note for user ${contextUserId}`, JSON.stringify(args, null, 2));
  await dbUtil.ensureCategoryExists(args.category);
  await dbUtil.createKnowledgeNote(contextUserId, args);
  return `✓ Saved to personal notes: "${args.title}"`;
}, { name: "save_note", schema: saveNoteSchema, description: "Save to personal private memory." });

const saveHouseNoteTool = tool(async (args) => {
  console.log(`[Tool] save_house_note by ${contextUserName}`, JSON.stringify(args, null, 2));
  await dbUtil.ensureCategoryExists(args.category);
  await dbUtil.createHouseNote({ ...args, author: contextUserName });
  return `✓ Saved to SHARED house notes: "${args.title}"`;
}, { name: "save_house_note", schema: saveHouseNoteSchema, description: "Save to shared house memory (visible to all household members)." });

const searchNotesTool = tool(async (args) => {
  console.log(`[Tool] search_notes for ${contextUserId}`, args.query);
  
  // 1. Fetch from both tables
  const personalNotes = await dbUtil.queryKnowledge(contextUserId);
  const houseNotes = await dbUtil.queryHouseKnowledge();
  
  // 2. Tag notes so AI knows the source
  const formattedPersonal = personalNotes.map(n => ({ ...n, source: "Personal Memory", author: "You" }));
  const formattedHouse = houseNotes.map(n => ({ ...n, source: "Shared House Memory", author: n.author || "Unknown" }));
  
  // 3. Combine and rank using similarity search
  const allNotes = [...formattedPersonal, ...formattedHouse];
  const rankedNotes = searchUtil.rankItems(args.query, allNotes, 10);
  
  return rankedNotes.length > 0 
    ? JSON.stringify(rankedNotes.map(n => ({ 
        title: n.title, 
        content: n.content, 
        category: n.category,
        author: n.author, 
        source: n.source 
      }))) 
    : "No matching notes found in personal or house memory.";
}, { name: "search_notes", schema: searchSchema, description: "Search all memories (both your personal notes and shared house notes) using similarity matching." });

const listNotesByCategoryTool = tool(async (args) => {
  console.log(`[Tool] list_notes_by_category for user ${contextUserId}`, args.category);
  
  // Only fetch for the specific user as requested
  const personalNotes = await dbUtil.queryKnowledge(contextUserId);
  
  const normalizedCategory = args.category.toLowerCase();
  const matches = personalNotes.filter(n => (n.category || "").toLowerCase() === normalizedCategory);
  
  return matches.length > 0 
    ? JSON.stringify(matches.map(n => ({ 
        title: n.title, 
        content: n.content, 
        category: n.category,
        author: "You", 
        source: "Personal Memory" 
      }))) 
    : `No personal notes found in the category "${args.category}".`;
}, { name: "list_notes_by_category", schema: listByCategorySchema, description: "List all personal notes for the current user that belong to a specific category." });

const tools = [saveNoteTool, saveHouseNoteTool, searchNotesTool, listNotesByCategoryTool];
const toolNode = new ToolNode(tools);

// Graph
const AgentState = Annotation.Root({
  messages: Annotation({ reducer: messagesStateReducer }),
  messageTimestamp: Annotation({ reducer: (old, newVal) => newVal }),
  userName: Annotation({ reducer: (old, newVal) => newVal }),
  categories: Annotation({ reducer: (old, newVal) => newVal }),
});

async function callModel(state, config) {
  const { messages, messageTimestamp, userName, categories = [] } = state;
  const userId = config?.configurable?.userId;
  
  // Set module-level context for tools to access
  contextUserId = userId;
  contextUserName = userName;
  
  const msgDate = new Date(messageTimestamp || Date.now());
  const dateStr = msgDate.toISOString().split('T')[0];
  const timeStr = msgDate.toTimeString().split(' ')[0];
  
  const categoryList = categories.length > 0 ? categories.map(c => c.name).join(", ") : "None yet";

  const systemPrompt = `You are a multi-channel assistant (WhatsApp/Telegram) with ONE PRIMARY FUNCTION: **IMMEDIATELY save relevant information to memory using tools**.

YOUR JOB IS TO SAVE DATA - NOT JUST CHAT.

PII & SENSITIVE INFO:
- DO NOT MASK ANY INFORMATION. Save and display full account numbers, card numbers, passwords, or IDs exactly as they appear. The user is providing this data intentionally for storage.

EXISTING CATEGORIES:
${categoryList}
(Instruction: Be specific with categories. Avoid overly generic terms like "Shopping", "Note", or "General". For example, instead of "Shopping", use "Electronics", "Books", "Groceries", or "Gifts" based on the content. Reuse an existing category ONLY if it is a precise fit; otherwise, create a new descriptive one that captures the specific nature of the info.)

CRITICAL TOOL INSTRUCTIONS:
========================
When a user provides ANY factual information (codes, numbers, dates, instructions, settings, etc.), YOU MUST IMMEDIATELY CALL THE APPROPRIATE TOOL:

**RULE 1: OTP DETECTION (ABSOLUTE PRIORITY)**
- IF ANY message contains the word "OTP" or looks like a one-time password/code:
- THEN: ALWAYS CALL save_house_note IMMEDIATELY (never save OTPs to personal memory).

**RULE 2: HOUSE INFORMATION**
- IF ANY message mentions: "house", "home", "family", "shared", "everyone", "all" OR contains useful household information
- THEN: CALL save_house_note IMMEDIATELY

**RULE 3: PERSONAL INFORMATION**
- Use save_note ONLY if info is purely personal and doesn't benefit others.

**RULE 4: SEARCHING & LISTING**
- If the user asks a specific question or looks for info by keyword, call search_notes.
- If the user asks to see from a specific category (e.g., "get all my restaurants"), call list_notes_by_category.
- if you don't get relavent info by calling specific category, then call search_notes with the query to find the best match across all categories.
**RULE 5: MANDATORY TOOL USAGE**
- BEFORE responding to ANY message with information, CALL the appropriate tool.
- DO NOT just acknowledge - DO NOT just chat.
- SAVE FIRST, THEN respond about what you saved.

TOOL SCHEMAS:
- save_house_note: { title, content, category, author, tags }
- save_note: { title, content, category, tags, reminderDate (optional) }
- search_notes: { query }
- list_notes_by_category: { category }

CONTEXT:
- User: ${userName}
- ID: ${userId}
- Date: ${dateStr} at ${timeStr}

ACTION PRIORITY:
1. Identify if info contains an OTP (Save to House Memory)
2. Identify if info is house-related (Save to House Memory)
3. Identify if info is personal (Save to Personal Memory)
4. Then provide user feedback about what was saved/found.

REMEMBER: If "OTP" is mentioned, it goes to Shared House Memory.`;
  
  const response = await model.bindTools(tools).invoke([new SystemMessage(systemPrompt), ...messages], config);
  console.log('AI Response Tool Calls:', JSON.stringify(response.tool_calls, null, 2));    
    // Log AI response for debugging
    const responseContent = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    console.log('AI Response Content:', responseContent);
      return { messages: [response] };
}

const workflow = new StateGraph(AgentState)
  .addNode("agent", callModel)
  .addNode("tools", toolNode)
  .addEdge("__start__", "agent")
  .addConditionalEdges("agent", (state) => state.messages[state.messages.length - 1].tool_calls?.length > 0 ? "tools" : "__end__")
  .addEdge("tools", "agent");

const app = workflow.compile();

module.exports = {
  processMessage: async (userId, userMessage, history = [], messageTimestamp, userName) => {
    console.log(`\n=== Processing Text Message ===`);
    console.log(`User: ${userName}, Message: "${userMessage}"`);
    
    const getUrls = (await import('get-urls')).default;
    const urls = [...getUrls(userMessage)];
    
    let contextualMessage = userMessage;

    // If there are URLs, try to fetch metadata
    if (urls.length > 0) {
      const urlMetadata = await getUrlMetadata(userMessage);
      
      // If Puppeteer failed or timed out, ask the user for info instead of calling AI
      if (!urlMetadata) {
        console.log(`[Metadata] Failed to fetch metadata for ${urls.length} URLs. Asking user for info.`);
        return "I see the link, but I couldn't peek inside to see what's there. 🧐 Could you tell me briefly what this link is about so I can save it correctly for you?";
      }

      contextualMessage += `\n\n[URL Metadata for Context]:\n${JSON.stringify(urlMetadata, null, 2)}`;
      console.log(`[Metadata] Added context for ${urlMetadata.length} URLs`);
    }

    // Fetch existing categories
    const categories = await dbUtil.getAllCategories();

    const formattedHistory = history.map(h => h.role === 'user' ? new HumanMessage(h.content) : { role: 'assistant', content: h.content });
    const result = await app.invoke(
      { messages: [...formattedHistory, new HumanMessage(contextualMessage)], messageTimestamp, userName, categories }, 
      { configurable: { userId, userName } }
    );
    
    const finalResponse = result.messages[result.messages.length - 1].content;
    console.log(`Final Response: ${finalResponse}`);
    console.log(`=== End Processing ===\n`);
    
    return finalResponse;
  },

  processImage: async (userId, imageBuffer, mimeType, caption = "", messageTimestamp, userName) => {
    console.log(`\n=== Processing Image ===`);
    console.log(`User: ${userName}, Caption: "${caption}"`);
    
    const msgDate = new Date(messageTimestamp || Date.now());
    const dateStr = msgDate.toISOString().split('T')[0];
    const timeStr = msgDate.toTimeString().split(' ')[0];

    // Fetch existing categories
    const categories = await dbUtil.getAllCategories();
    const categoryList = categories.length > 0 ? categories.map(c => c.name).join(", ") : "None yet";
    
    const visionPrompt = `Analyze this image in detail. Caption: "${caption}".
    
Today is ${dateStr} at ${timeStr}.

EXISTING CATEGORIES:
${categoryList}
(Instruction: Be specific with categories. Avoid overly generic terms like "Shopping", "Note", or "General". For example, instead of "Shopping", use "Electronics", "Books", "Groceries", or "Gifts" based on the content. Reuse an existing category ONLY if it is a precise fit; otherwise, create a new descriptive one that captures the specific nature of the info.)

If this image contains information worth remembering:
- Use 'save_note' for personal information
- Use 'save_house_note' if it's for shared household knowledge

Be thorough - extract all useful information and save it with appropriate title, content, category, and tags.`;

    const result = await app.invoke(
      { 
        messages: [new HumanMessage({
          content: [
            { type: "text", text: visionPrompt }, 
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBuffer.toString('base64')}` } }
          ]
        })], 
        messageTimestamp, 
        userName,
        categories
      }, 
      { configurable: { userId, userName } }
    );

    const finalMessage = result.messages[result.messages.length - 1];
    
    let aiText = "Image processed.";
    if (finalMessage.content) {
      if (typeof finalMessage.content === 'string') {
        aiText = finalMessage.content;
      } else if (Array.isArray(finalMessage.content)) {
        aiText = finalMessage.content
          .filter(block => typeof block === 'string' || block.type === 'text')
          .map(block => typeof block === 'string' ? block : block.text)
          .join(' ');
      }
    }
    
    // Find the first tool call for the extracted note return (optional/legacy support)
    const toolCall = result.messages.find(m => m.tool_calls?.length > 0)?.tool_calls?.[0];
    
    console.log(`Image Analysis Response: ${aiText}`);
    console.log(`Tool Calls Found: ${toolCall ? 'Yes' : 'No'}`);
    console.log(`=== End Image Processing ===\n`);

    return { 
      aiResponse: aiText || "Image processed and information saved.", 
      extractedNote: toolCall?.args 
    };
  },

  consolidateReminders: async (reminders, userName, timeframe) => {
    if (!reminders || reminders.length === 0) return null;

    const reminderText = reminders.map(r => `- [${r.category}] ${r.title}: ${r.content} (Due: ${r.reminderDate})`).join('\n');
    
    const prompt = `You are a helpful personal assistant. I have a list of reminders for ${userName} for ${timeframe}.
    
Please consolidate these reminders into a single, friendly, and well-formatted message.
Group them by category if appropriate. Use emojis to make it look professional yet friendly.

Reminders:
${reminderText}`;

    const response = await model.invoke([new HumanMessage(prompt)]);
    return response.content;
  }
};

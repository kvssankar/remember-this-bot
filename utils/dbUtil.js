const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const crypto = require('crypto');

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(client);

const MESSAGES_TABLE = process.env.DYNAMODB_TABLE_MESSAGES || 'WhatsAppMessages';
const KNOWLEDGE_TABLE = process.env.DYNAMODB_TABLE_KNOWLEDGE || 'WhatsAppKnowledge';
const CATEGORIES_TABLE = process.env.DYNAMODB_TABLE_CATEGORIES || 'WhatsAppCategories';

const HOUSE_TABLE = process.env.DYNAMODB_TABLE_HOUSE || 'WhatsAppHouse';
const HOUSE_ID = 'SHARED_HOUSE';

const dbUtil = {
  /**
   * Helper to calculate TTL in seconds
   */
  getTTL(days) {
    return Math.floor(Date.now() / 1000) + (days * 24 * 60 * 60);
  },

  /**
   * Get all categories
   */
  async getAllCategories() {
    try {
      const command = new ScanCommand({
        TableName: CATEGORIES_TABLE,
      });
      const response = await docClient.send(command);
      return response.Items || [];
    } catch (err) {
      console.error("[DB] Error fetching categories:", err.message);
      return [];
    }
  },

  /**
   * Ensure a category exists (case-insensitive check)
   */
  async ensureCategoryExists(categoryName) {
    if (!categoryName) return;
    
    const categories = await this.getAllCategories();
    const normalizedName = categoryName.trim();
    const exists = categories.some(c => c.name.toLowerCase() === normalizedName.toLowerCase());

    if (!exists) {
      console.log(`[DB] Creating new category: ${normalizedName}`);
      const command = new PutCommand({
        TableName: CATEGORIES_TABLE,
        Item: {
          name: normalizedName,
          createdAt: new Date().toISOString()
        },
      });
      await docClient.send(command);
    }
  },

  /**
   * Create a shared house note
   */
  async createHouseNote({ title, content, category, author, tags = [] }) {
    const item = {
      houseId: HOUSE_ID,
      noteId: crypto.randomUUID(),
      title,
      content,
      category,
      author,
      tags,
      status: 'active',
      createdAt: new Date().toISOString(),
    };

    // TTL logic: Only for OTPs (1 month)
    const isOTP = (title + " " + content).toLowerCase().includes('otp');
    if (isOTP) {
      item.ttl = this.getTTL(30);
    }

    const command = new PutCommand({
      TableName: HOUSE_TABLE,
      Item: item,
    });
    return await docClient.send(command);
  },

  /**
   * Query house knowledge
   */
  async queryHouseKnowledge() {
    const command = new QueryCommand({
      TableName: HOUSE_TABLE,
      KeyConditionExpression: "houseId = :houseId",
      ExpressionAttributeValues: {
        ":houseId": HOUSE_ID,
      },
    });
    const response = await docClient.send(command);
    return response.Items || [];
  },
  /**
   * Save a message to the chat history (Short-term memory)
   * @param {string} userId - Sender's ID
   * @param {object} message - { role: 'user'|'assistant', type: 'text'|'image', content: string }
   */
  async saveMessage(userId, { role, type, content }) {
    const command = new PutCommand({
      TableName: MESSAGES_TABLE,
      Item: {
        userId,
        timestamp: Date.now(),
        role,
        type,
        content,
        ttl: this.getTTL(7) // 1 week TTL for messages
      },
    });
    return await docClient.send(command);
  },

  /**
   * Get recent messages for context (Short-term memory)
   */
  async getRecentMessages(userId, limit = 15) {
    const command = new QueryCommand({
      TableName: MESSAGES_TABLE,
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: {
        ":userId": userId,
      },
      ScanIndexForward: false, // Latest first
      Limit: limit,
    });
    const response = await docClient.send(command);
    return response.Items ? response.Items.reverse() : []; // Return in chronological order
  },

  /**
   * Create a long-term note or reminder (Long-term memory)
   */
  async createKnowledgeNote(userId, { title, content, category, tags = [], reminderDate = null }) {
    const item = {
      userId,
      noteId: crypto.randomUUID(),
      title,
      content,
      category,
      tags,
      reminderDate,
      status: 'active',
      createdAt: new Date().toISOString(),
    };

    // TTL logic
    const isOTP = (title + " " + content).toLowerCase().includes('otp');

    if (reminderDate) {
      // If reminder is set, expire 7 days after the reminder date
      const reminderTimestamp = Math.floor(new Date(reminderDate).getTime() / 1000);
      if (!isNaN(reminderTimestamp)) {
        item.ttl = reminderTimestamp + (7 * 24 * 60 * 60);
      }
    } else if (isOTP) {
      // 1 month TTL for OTPs
      item.ttl = this.getTTL(30);
    }

    const command = new PutCommand({
      TableName: KNOWLEDGE_TABLE,
      Item: item,
    });
    return await docClient.send(command);
  },

  /**
   * Query knowledge (Long-term memory)
   */
  async queryKnowledge(userId) {
    const command = new QueryCommand({
      TableName: KNOWLEDGE_TABLE,
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: {
        ":userId": userId,
      },
    });
    const response = await docClient.send(command);
    return response.Items || [];
  },

  /**
   * Update note status (e.g., mark reminder as completed)
   */
  async updateNoteStatus(userId, noteId, status) {
    const command = new UpdateCommand({
      TableName: KNOWLEDGE_TABLE,
      Key: { userId, noteId },
      UpdateExpression: "set #status = :status",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":status": status },
    });
    return await docClient.send(command);
  },

  /**
   * Count messages sent by user today
   */
  async getDailyMessageCount(userId) {
    const startOfDay = new Date().setHours(0, 0, 0, 0);
    const command = new QueryCommand({
      TableName: MESSAGES_TABLE,
      KeyConditionExpression: "userId = :userId AND #ts >= :startOfDay",
      ExpressionAttributeNames: {
        "#ts": "timestamp",
      },
      ExpressionAttributeValues: {
        ":userId": userId,
        ":startOfDay": startOfDay,
      },
      Select: "COUNT",
    });
    const response = await docClient.send(command);
    return response.Count || 0;
  },

  /**
   * Get all active reminders that are due
   */
  async getDueReminders() {
    const now = new Date().toISOString();
    
    const command = new ScanCommand({
        TableName: KNOWLEDGE_TABLE,
        FilterExpression: "attribute_exists(reminderDate) AND #status = :status AND reminderDate <= :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":status": "active", ":now": now }
    });

    const response = await docClient.send(command);
    return response.Items || [];
  },

  /**
   * Get reminders within a specific ISO date range (Inclusive)
   */
  async getRemindersInRange(startISO, endISO) {
    const command = new ScanCommand({
        TableName: KNOWLEDGE_TABLE,
        FilterExpression: "attribute_exists(reminderDate) AND #status = :status AND reminderDate BETWEEN :start AND :end",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { 
            ":status": "active", 
            ":start": startISO,
            ":end": endISO 
        }
    });

    const response = await docClient.send(command);
    return response.Items || [];
  }
};

module.exports = dbUtil;

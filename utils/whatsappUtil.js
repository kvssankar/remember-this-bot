const axios = require('axios');

const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERSION = 'v25.0';

const whatsappUtil = {
  /**
   * Send a text message to a specific number
   */
  async sendMessage(to, text) {
    const url = `https://graph.facebook.com/${VERSION}/${PHONE_NUMBER_ID}/messages`;
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to,
      type: "text",
      text: { body: text },
    };

    console.log('Sending WhatsApp request to:', url);
    console.log('Payload:', JSON.stringify(payload, null, 2));
    // Masking token for security in logs
    console.log('Using Token (start):', WHATSAPP_TOKEN?.substring(0, 15) + '...');

    try {
      const response = await axios.post(
        url,
        payload,
        {
          headers: {
            Authorization: `Bearer ${WHATSAPP_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );
      console.log('WhatsApp API Response Success:', JSON.stringify(response.data, null, 2));
      return response.data;
    } catch (error) {
      console.error('WhatsApp API Error Response:', JSON.stringify(error.response?.data || {}, null, 2));
      console.error('Full Error Status:', error.response?.status);
      console.error('Full Error Headers:', JSON.stringify(error.response?.headers || {}, null, 2));
      throw error;
    }
  },

  /**
   * Download media (image) from WhatsApp
   * 1. Get media URL using mediaId
   * 2. Download binary data
   */
  async downloadMedia(mediaId) {
    try {
      // Step 1: Get the Media URL
      const getUrl = `https://graph.facebook.com/${VERSION}/${mediaId}`;
      const urlResponse = await axios.get(getUrl, {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      });

      const mediaUrl = urlResponse.data.url;
      const mimeType = urlResponse.data.mime_type;

      // Step 2: Download the binary data
      const downloadResponse = await axios.get(mediaUrl, {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
        responseType: 'arraybuffer',
      });

      return {
        data: Buffer.from(downloadResponse.data),
        mimeType: mimeType,
      };
    } catch (error) {
      console.error('Error downloading WhatsApp media:', error.response?.data || error.message);
      throw error;
    }
  }
};

module.exports = whatsappUtil;

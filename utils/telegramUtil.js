const axios = require('axios');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const telegramUtil = {
  /**
   * Send a text message to a Telegram user
   * HTML mode is more robust than Markdown for AI-generated content.
   */
  async sendMessage(chatId, text, parseMode = 'HTML') {
    const url = `${BASE_URL}/sendMessage`;
    
    let formattedText = text;
    
    // Convert AI's common Markdown syntax to HTML for robustness
    if (parseMode === 'HTML') {
      formattedText = text
        .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>') // **bold** -> <b>bold</b>
        .replace(/\*(.*?)\*/g, '<i>$1</i>');    // *italic* -> <i>italic</i>
    }

    const payload = {
      chat_id: chatId,
      text: formattedText,
      parse_mode: parseMode,
    };

    console.log('Sending Telegram message to:', chatId);

    try {
      const response = await axios.post(url, payload);
      return response.data;
    } catch (error) {
      const errorData = error.response?.data || {};
      console.error('Telegram API Error (sendMessage):', JSON.stringify(errorData));

      // Fallback: If HTML/Markdown parsing fails, try sending as plain text
      if (error.response?.status === 400 && parseMode !== null) {
        console.log("Retrying as plain text due to parsing error...");
        try {
          const fallbackResponse = await axios.post(url, { 
            chat_id: chatId, 
            text: text 
          });
          return fallbackResponse.data;
        } catch (retryErr) {
          console.error("Plain text retry failed:", retryErr.message);
        }
      }
      throw error;
    }
  },

  /**
   * Download a file from Telegram
   */
  async downloadFile(fileId) {
    try {
      const getFileUrl = `${BASE_URL}/getFile?file_id=${fileId}`;
      const pathResponse = await axios.get(getFileUrl);
      const filePath = pathResponse.data.result.file_path;

      const downloadUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
      const downloadResponse = await axios.get(downloadUrl, {
        responseType: 'arraybuffer',
      });

      const extension = filePath.split('.').pop();
      const mimeType = `image/${extension === 'jpg' ? 'jpeg' : extension}`;

      return {
        data: Buffer.from(downloadResponse.data),
        mimeType: mimeType,
      };
    } catch (error) {
      console.error('Error downloading Telegram file:', error.response?.data || error.message);
      throw error;
    }
  }
};

module.exports = telegramUtil;

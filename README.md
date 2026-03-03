# Remember This Bot 🤖

A "save-everything" Telegram & WhatsApp bot that helps you dump links, notes, images, and ideas, then uses AI (AWS Bedrock) to answer questions or remind you later.

## Features
- **Multi-Platform**: Works on Telegram and WhatsApp.
- **AI-Powered**: Uses AWS Bedrock (Claude) to understand and organize your notes.
- **Auto-Reminders**: Automatically notifies you of upcoming tasks or saved items.
- **Practically Free**: Built on AWS Lambda (Serverless) — costs cents per month for personal use.

---

## 🚀 Built with Gemini CLI

This project was built and refined using **Gemini CLI**. You can use Gemini to extend or maintain this project with simple natural language commands.

### How to use Gemini to build/modify this:
1. **Initialize Gemini**: Run `gemini` in this folder.
2. **Ask Questions**: "Explain how the reminder logic works in index.js"
3. **Add Features**: "Gemini, add a new tool to summarize the last 5 links I saved."
4. **Refactor**: "Gemini, optimize the database queries in dbUtil.js."

---

## 🛠️ Deployment via Gemini (AWS CLI)

You can deploy this entire stack using Gemini CLI by giving it high-level instructions.

### 1. Prerequisites
- AWS CLI installed and configured (\`aws configure\`).
- Node.js installed.

### 2. Deployment Steps (Ask Gemini)
Simply tell Gemini:
> "Gemini, help me deploy this bot to AWS. Follow the steps in aws/AWS_SETUP.md and use my .env.example values as placeholders."

Gemini will autonomously:
1. **Create DynamoDB Tables**: Sets up the messaging and knowledge tables.
2. **Setup IAM Roles**: Creates the necessary permissions for Lambda.
3. **Zip & Upload**: Packages the code and creates the Lambda function.
4. **API Gateway**: Sets up the public webhook URL for Telegram/WhatsApp.

---

## ⚙️ Configuration
1. Rename \`.env.example\` to \`.env\`.
2. Fill in your API keys for Telegram and WhatsApp (Meta).
3. Set your AWS Region (default: \`us-east-1\`).

---

## 📂 Project Structure
- \`index.js\`: Entry point for Lambda handlers (Webhook & Processor).
- \`services/\`: AI logic using LangChain and AWS Bedrock.
- \`utils/\`: Helper functions for DB (DynamoDB), Telegram, and WhatsApp.
- \`aws/\`: IAM policies and step-by-step setup guides.

---

## 📝 License
MIT
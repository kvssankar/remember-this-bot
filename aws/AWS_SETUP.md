# AWS Infrastructure Setup Guide

**Important:** Before starting, navigate to the `aws` directory:
```bash
cd aws
```

This guide provides the AWS CLI commands to deploy the WhatsApp Assistant backend. Ensure you have the [AWS CLI installed](https://aws.amazon.com/cli/) and configured with `aws configure`.

## 1. Create DynamoDB Tables

Run these commands to create the two required tables for short-term memory and long-term knowledge.

```bash
# 1. Chat History Table (Short-term memory)
aws dynamodb create-table 
    --table-name WhatsAppMessages 
    --attribute-definitions 
        AttributeName=userId,AttributeType=S 
        AttributeName=timestamp,AttributeType=N 
    --key-schema 
        AttributeName=userId,KeyType=HASH 
        AttributeName=timestamp,KeyType=RANGE 
    --billing-mode PAY_PER_REQUEST

# 2. Knowledge & Reminders Table (Long-term memory)
aws dynamodb create-table 
    --table-name WhatsAppKnowledge 
    --attribute-definitions 
        AttributeName=userId,AttributeType=S 
        AttributeName=noteId,AttributeType=S 
    --key-schema 
        AttributeName=userId,KeyType=HASH 
        AttributeName=noteId,KeyType=RANGE 
    --billing-mode PAY_PER_REQUEST
```

## 2. Setup IAM Role for Lambda

Create a role that allows Lambda to access DynamoDB, Bedrock, and CloudWatch Logs.

```bash
# 1. Create the Trust Policy
cat <<EOF > trust-policy.json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

# 2. Create the Role
aws iam create-role --role-name LambdaWhatsAppRole --assume-role-policy-document file://trust-policy.json

# 3. Create the Permission Policy
cat <<EOF > permission-policy.json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:Scan"
      ],
      "Resource": [
        "arn:aws:dynamodb:us-east-1:*:table/WhatsAppMessages", 
        "arn:aws:dynamodb:us-east-1:*:table/WhatsAppKnowledge"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel"],
      "Resource": ["arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0"]
    },
    {
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": ["arn:aws:logs:*:*:*"]
    }
  ]
}
EOF

# 4. Attach Policy to Role
aws iam put-role-policy --role-name LambdaWhatsAppRole --policy-name WhatsAppBotPolicy --policy-document file://permission-policy.json
```

## 3. Deploy the Lambda Function

First, package the project:
```bash
npm run zip
```

Then, create the function. Replace `your_id`, `your_token`, and `your_secret` with your Meta credentials.

```bash
# Get the Role ARN
ROLE_ARN=$(aws iam get-role --role-name LambdaWhatsAppRole --query 'Role.Arn' --output text)

aws lambda create-function 
    --function-name WhatsAppAssistant 
    --runtime nodejs20.x 
    --role $ROLE_ARN 
    --handler index.handler 
    --zip-file fileb://function.zip 
    --timeout 60 
    --memory-size 256 
    --environment "Variables={WHATSAPP_PHONE_NUMBER_ID=your_id,WHATSAPP_ACCESS_TOKEN=your_token,META_VERIFY_TOKEN=your_secret,BEDROCK_MODEL_ID=anthropic.claude-haiku-4-5-20251001-v1:0,AWS_REGION=us-east-1}"
```

## 4. Setup API Gateway (Webhook URL)

This creates the public URL for the Meta Webhook.

```bash
# 1. Create API
API_ID=$(aws apigatewayv2 create-api --name "WhatsAppWebhookAPI" --protocol-type HTTP --query 'ApiId' --output text)

# 2. Create Integration
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
INTEGRATION_ID=$(aws apigatewayv2 create-integration --api-id $API_ID --integration-type AWS_PROXY --integration-uri arn:aws:lambda:us-east-1:$ACCOUNT_ID:function:WhatsAppAssistant --payload-format-version 2.0 --query 'IntegrationId' --output text)

# 3. Create Route
aws apigatewayv2 create-route --api-id $API_ID --route-key "ANY /webhook" --target integrations/$INTEGRATION_ID

# 4. Create Stage (Auto-deploy)
aws apigatewayv2 create-stage --api-id $API_ID --stage-name '$default' --auto-deploy

# 5. Grant Permission to API Gateway to invoke Lambda
aws lambda add-permission 
    --function-name WhatsAppAssistant 
    --statement-id apigateway-access 
    --action lambda:InvokeFunction 
    --principal apigateway.amazonaws.com 
    --source-arn "arn:aws:execute-api:us-east-1:$ACCOUNT_ID:$API_ID/*"
```

**Your Webhook URL:** `https://$API_ID.execute-api.us-east-1.amazonaws.com/webhook`

## 5. Setup EventBridge (Twice-Daily Reminders)

This schedules the `reminderHandler` to run twice daily.

```bash
# 1. Create Rule
aws events put-rule --name "WhatsAppReminderCron" --schedule-expression "cron(0 8,20 * * ? *)"

# 2. Create a separate target for the reminderHandler
# Note: Since the same Lambda is used, ensure your index.js exports reminderHandler correctly.
aws events put-targets --rule "WhatsAppReminderCron" --targets "Id"="1","Arn"="arn:aws:lambda:us-east-1:$ACCOUNT_ID:function:WhatsAppAssistant"

# 3. Grant Permission to EventBridge to invoke Lambda
aws lambda add-permission 
    --function-name WhatsAppAssistant 
    --statement-id eventbridge-cron 
    --action lambda:InvokeFunction 
    --principal events.amazonaws.com 
    --source-arn "arn:aws:events:us-east-1:$ACCOUNT_ID:rule/WhatsAppReminderCron"
```

**CRITICAL NOTE:** After creating the EventBridge target, you must manually (or via another CLI command) update the target to use the specific `reminderHandler`. By default, it will trigger the main `handler` (`index.handler`). 

To fix this via CLI:
1. Go to AWS Console -> EventBridge -> Rules -> WhatsAppReminderCron.
2. Edit Target -> Header: `reminderHandler`.

*(Alternatively, create a separate Lambda function just for reminders pointing to the same code but with a different handler configuration).*

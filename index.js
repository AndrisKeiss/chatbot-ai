const { createAssistant, uploadImage } = require("./openai.service");
const OpenAI = require("openai");
const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize DynamoDB client
const dynamoDB = new DynamoDBClient({ region: process.env.AWS_REGION_NAME });

// Assistant instance
let assistant = null;

exports.handler = async (event) => {
  // Log the event object for debugging
  console.log('Event:', JSON.stringify(event, null, 2));

  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*', // Adjust as needed
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  };

  // Extract the HTTP method and path
  const method = event.requestContext?.http?.method || event.httpMethod;
  let path = event.rawPath || event.path || '/';
  path = path.replace(/\/+$/, '').toLowerCase();

  // Log the method and path for debugging
  console.log('Method:', method);
  console.log('Path:', path);

  // Handle preflight OPTIONS request
  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: '',
    };
  }

  try {
    // Parse the incoming request body
    const body = event.body && event.body !== '' ? JSON.parse(event.body) : {};

    // Create or retrieve the assistant instance
    if (!assistant) {
      assistant = await createAssistant(openai);
    }

    // Handle GET request for "/start" endpoint
    if (path === '/start' && method === 'GET') {
      console.log('Handling GET /start');
      const thread = await openai.beta.threads.create();

      // Save thread ID to DynamoDB
      const threadId = thread.id;
      const timestamp = new Date().toISOString();

      const putItemParams = {
        TableName: process.env.DYNAMODB_TABLE_NAME,
        Item: {
          'thread_id': { S: threadId },
          'timestamp': { S: timestamp },
        },
      };

      await dynamoDB.send(new PutItemCommand(putItemParams));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ thread_id: threadId }),
      };
    }

    // Handle POST request for "/chat" endpoint
    if (path === '/chat' && method === 'POST') {
      console.log('Handling POST /chat');
      const { thread_id, message } = body;

      if (!thread_id) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Missing thread_id' }),
        };
      }

      console.log('Received message:', message);

      const newMessage = {
        role: 'user',
        content: [],
      };

      // Handle cases where message is a string or an object
      if (typeof message === 'string') {
        newMessage.content.push({ type: 'text', text: message });
      } else if (message.text) {
        newMessage.content.push({ type: 'text', text: message.text });
      }

      if (message.image_url) {
        const fileId = await uploadImage(openai, message.image_url);
        newMessage.content.push({
          type: 'image_file',
          image_file: {
            file_id: fileId,
          },
        });
      }

      // Ensure the content array is not empty
      if (newMessage.content.length === 0) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Message content is empty' }),
        };
      }

      console.log('Sending new message to assistant:', JSON.stringify(newMessage, null, 2));

      // Send the message to OpenAI
      await openai.beta.threads.messages.create(thread_id, newMessage);

      // Run the assistant and retrieve the response
      const run = await openai.beta.threads.runs.createAndPoll(thread_id, {
        assistant_id: assistant.id,
      });

      console.log('Run details:', JSON.stringify(run, null, 2));

      // Fetch the messages in the thread
      const messagesResponse = await openai.beta.threads.messages.list(thread_id);
      const messages = messagesResponse.data;

      console.log('Messages in thread:', JSON.stringify(messages, null, 2));

      // Assume the assistant's response is at messages[0]
      let responseMessage = '';

      if (messages && messages.length > 0) {
        const assistantMessage = messages[0];
        if (assistantMessage.role === 'assistant' && assistantMessage.content && assistantMessage.content.length > 0) {
          const contentItem = assistantMessage.content[0];
          if (contentItem.type === 'text' && contentItem.text && contentItem.text.value) {
            responseMessage = contentItem.text.value;
          } else {
            console.error('Unexpected content format in assistant message:', contentItem);
            return {
              statusCode: 500,
              headers,
              body: JSON.stringify({ error: 'Invalid assistant response format' }),
            };
          }
        } else {
          console.error('Latest message is not from assistant');
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'No assistant response' }),
          };
        }
      } else {
        console.error('No messages found in thread');
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: 'No messages in thread' }),
        };
      }

      console.log('Assistant response:', responseMessage);

      // Save conversation to DynamoDB
      const timestamp = new Date().toISOString();

      const putItemParams = {
        TableName: process.env.DYNAMODB_TABLE_NAME,
        Item: {
          'thread_id': { S: thread_id },
          'timestamp': { S: timestamp },
          'user_message': { S: JSON.stringify(message) },
          'assistant_response': { S: responseMessage },
        },
      };

      await dynamoDB.send(new PutItemCommand(putItemParams));

      // Return the assistant's response
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ response: responseMessage }),
      };
    }

    // Return 404 for any unknown endpoints
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Endpoint not found' }),
    };
  } catch (error) {
    console.error('Error processing request', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
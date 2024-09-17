const fs = require("fs");
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const fetch = require('node-fetch'); // Include if using Node.js < 18
const { downloadImage, removeImage } = require("./utilities.service");

// Initialize S3 Client
const s3 = new S3Client({ region: process.env.AWS_REGION_NAME });

// Cache assistant in memory between Lambda invocations
let cachedAssistant = null;

const createAssistant = async (openai) => {
  const assistantFilePath = "/tmp/assistant.json";
  const knowledgeBaseFilePath = "/tmp/knowledgebase.docx";
  const bucketName = process.env.BUCKET_NAME;
  const assistantJsonKey = "assistant.json";
  const knowledgeBaseFileName = "knowledgebase.docx";
  const instructionsFileName = "instructions.txt";

  // Use cached assistant if available
  if (cachedAssistant) {
    console.log("Using cached assistant.");
    return cachedAssistant;
  }

  // Check if assistant.json exists in S3
  console.log("Checking for assistant.json in S3...");
  let assistantJsonData;
  try {
    const command = new GetObjectCommand({ Bucket: bucketName, Key: assistantJsonKey });
    assistantJsonData = await s3.send(command);
    console.log("assistant.json found in S3.");
  } catch (err) {
    console.log("assistant.json not found in S3, proceeding to create a new assistant...");
  }

  if (assistantJsonData && assistantJsonData.Body) {
    // Convert stream to string and parse JSON
    const assistantJsonBody = await streamToString(assistantJsonData.Body);
    const assistant = JSON.parse(assistantJsonBody);

    // Cache assistant and return
    cachedAssistant = assistant;
    return assistant;
  }

  // Retrieve instructions.txt from S3
  console.log("Retrieving instructions.txt from S3...");
  let instructionsData;
  try {
    const instructionsCommand = new GetObjectCommand({ Bucket: bucketName, Key: instructionsFileName });
    instructionsData = await s3.send(instructionsCommand);
    console.log("instructions.txt successfully retrieved from S3.");
  } catch (err) {
    console.error("Error retrieving instructions.txt from S3:", err);
    throw err;
  }

  if (!instructionsData.Body) {
    throw new Error("instructions.txt Body is empty.");
  }

  // Read instructions into a string
  const instructions = await streamToString(instructionsData.Body);

  // Retrieve knowledge base from S3
  console.log("Retrieving knowledgebase.docx from S3...");
  let knowledgeBaseData;
  try {
    const knowledgeBaseCommand = new GetObjectCommand({ Bucket: bucketName, Key: knowledgeBaseFileName });
    knowledgeBaseData = await s3.send(knowledgeBaseCommand);
    console.log("knowledgebase.docx successfully retrieved from S3.");
  } catch (err) {
    console.error("Error retrieving knowledgebase.docx from S3:", err);
    throw err;
  }

  if (!knowledgeBaseData.Body) {
    throw new Error("knowledgebase.docx Body is empty.");
  }

  // Write knowledge base to /tmp
  await streamToFile(knowledgeBaseData.Body, knowledgeBaseFilePath);

  // Upload knowledge base to OpenAI
  console.log("Uploading knowledge base to OpenAI...");
  const file = await openai.files.create({
    file: fs.createReadStream(knowledgeBaseFilePath),
    purpose: "assistants",
  });
  console.log("Knowledge base uploaded to OpenAI.");

  // Check if vector store already exists
  console.log("Checking for existing vector store...");
  const vectorStores = await openai.beta.vectorStores.list();
  let vectorStore = vectorStores.data.find(vs => vs.name === "Chatbot-AI");

  if (!vectorStore) {
    console.log("Creating vector store in OpenAI...");
    vectorStore = await openai.beta.vectorStores.create({
      name: "Chatbot-AI",
      file_ids: [file.id],
    });
    console.log("Vector store created successfully.");
  } else {
    console.log("Vector store already exists.");
  }

  // Check if assistant already exists
  console.log("Checking for existing assistant...");
  const assistants = await openai.beta.assistants.list();
  let assistant = assistants.data.find(a => a.name === "Chatbot-AI");

  if (!assistant) {
    console.log("Creating assistant in OpenAI...");
    assistant = await openai.beta.assistants.create({
      name: "Chatbot-AI",
      instructions: instructions,
      tools: [{ type: "file_search" }],
      tool_resources: { file_search: { vector_store_ids: [vectorStore.id] } },
      model: "gpt-4o-mini",
    });
    console.log("Assistant created successfully.");
  } else {
    console.log("Assistant already exists.");
  }

  // Cache assistant in memory
  cachedAssistant = assistant;

  // Upload assistant.json to S3 for future use
  console.log("Uploading assistant.json to S3 for future use...");
  const putCommand = new PutObjectCommand({
    Bucket: bucketName,
    Key: assistantJsonKey,
    Body: JSON.stringify(assistant),
    ContentType: "application/json",
  });
  await s3.send(putCommand);
  console.log("assistant.json uploaded to S3 successfully.");

  return assistant;
};

// Helper function to convert stream to string
const streamToString = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    stream.on("error", reject);
  });

// Helper function to write stream to file
const streamToFile = (stream, filePath) =>
  new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(filePath);
    stream.pipe(writeStream);
    stream.on('end', resolve);
    stream.on('error', reject);
    writeStream.on('error', reject);
  });

const uploadImage = async (openai, url) => {
  const filePath = '/tmp/' + Date.now() + '-image';

  // Download the image to /tmp
  await downloadImage(url, filePath);

  // Upload the image to OpenAI
  const file = await openai.files.create({
    file: fs.createReadStream(filePath),
    purpose: "vision",
  });

  // Remove the image from /tmp
  removeImage(filePath);

  return file.id;
};

module.exports = { createAssistant, uploadImage };
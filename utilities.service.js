const fs = require('fs');
const fetch = require('node-fetch'); // Include if using Node.js < 18

const downloadImage = async (url, filePath) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image from URL: ${url}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Write the image to specified filePath
  fs.writeFileSync(filePath, buffer);
};

const removeImage = (filePath) => {
  fs.unlinkSync(filePath);
};

module.exports = { downloadImage, removeImage };
const mongoose = require("mongoose");

const MONGODB_URI = process.env.MONGODB_URI || "";

let connected = false;

async function connectDB() {
  if (!MONGODB_URI) {
    console.log("[MongoDB] No MONGODB_URI — running with file cache only");
    return false;
  }
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 10,
    });
    connected = true;
    console.log("[MongoDB] Connected to Atlas");
    return true;
  } catch (err) {
    console.warn("[MongoDB] Connection failed:", err.message);
    console.log("[MongoDB] Falling back to file cache");
    return false;
  }
}

function isConnected() {
  return connected && mongoose.connection.readyState === 1;
}

module.exports = { connectDB, isConnected };

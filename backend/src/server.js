require("dotenv").config();

const http = require("http");
const app = require("./app");
const connectDB = require("./config/db");

const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    await connectDB();

    const server = http.createServer(app);

    // The third teammate can attach Socket.IO to this same HTTP server later.
    // Example: initializeSocket(server) from src/socket/index.js

    server.listen(PORT, () => {
      console.log(`IntelliMeet backend running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
}

startServer();

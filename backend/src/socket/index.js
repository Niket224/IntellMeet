const { Server } = require("socket.io");
const createCorsOptions = require("../config/cors");
const { authenticateSocket } = require("./auth.socket");
const registerConnectionHandlers = require("./connection.socket");
const createPresenceStore = require("./presence.store");
const createChatState = require("./chat.state");

function initializeSocket(server) {
  const io = new Server(server, {
    cors: createCorsOptions()
  });

  const chatState = createChatState();
  server.once("close", () => chatState.close());
  io.use(authenticateSocket);
  registerConnectionHandlers(io, createPresenceStore(), chatState);
  return io;
}

module.exports = initializeSocket;

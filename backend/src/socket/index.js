
const { setIo } = require("./io");
const { Server } = require("socket.io");
const createCorsOptions = require("../config/cors");
const { authenticateSocket } = require("./auth.socket");
const registerConnectionHandlers = require("./connection.socket");
const createPresenceStore = require("./presence.store");
const createChatState = require("./chat.state");
const createWebrtcState = require("./webrtc.state");

function initializeSocket(server) {
  const io = new Server(server, {
    cors: createCorsOptions()
  });

  const chatState = createChatState();
  const webrtcState = createWebrtcState();
  server.once("close", () => {
    chatState.close();
    webrtcState.close();
  });
  io.use(authenticateSocket);
  registerConnectionHandlers(io, createPresenceStore(), chatState, webrtcState);
  setIo(io);
  return io;
}

module.exports = initializeSocket;

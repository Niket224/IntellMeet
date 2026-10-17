const { Server } = require("socket.io");
const createCorsOptions = require("../config/cors");
const { authenticateSocket } = require("./auth.socket");
const registerConnectionHandlers = require("./connection.socket");
const createPresenceStore = require("./presence.store");

function initializeSocket(server) {
  const io = new Server(server, {
    cors: createCorsOptions()
  });

  io.use(authenticateSocket);
  registerConnectionHandlers(io, createPresenceStore());
  return io;
}

module.exports = initializeSocket;

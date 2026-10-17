const { Server } = require("socket.io");
const createCorsOptions = require("../config/cors");
const { authenticateSocket } = require("./auth.socket");
const registerConnectionHandlers = require("./connection.socket");

function initializeSocket(server) {
  const io = new Server(server, {
    cors: createCorsOptions()
  });

  io.use(authenticateSocket);
  registerConnectionHandlers(io);
  return io;
}

module.exports = initializeSocket;

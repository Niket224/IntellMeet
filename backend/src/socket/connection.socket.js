const { enforceSocketExpiry } = require("./auth.socket");

function registerConnectionHandlers(io) {
  io.on("connection", (socket) => {
    if (!enforceSocketExpiry(socket)) return;
    console.log(`Socket.IO connected: ${socket.id}`);

    socket.on("disconnect", (reason) => {
      console.log(`Socket.IO disconnected: ${socket.id} (${reason})`);
    });
  });
}

module.exports = registerConnectionHandlers;

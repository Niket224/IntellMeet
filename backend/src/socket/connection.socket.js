const { enforceSocketExpiry } = require("./auth.socket");
const registerMeetingHandlers = require("./meeting.socket");

function registerConnectionHandlers(io, presence) {
  io.on("connection", (socket) => {
    if (!enforceSocketExpiry(socket)) return;
    console.log(`Socket.IO connected: ${socket.id}`);
    registerMeetingHandlers(io, socket, presence);

    socket.on("disconnect", (reason) => {
      console.log(`Socket.IO disconnected: ${socket.id} (${reason})`);
    });
  });
}

module.exports = registerConnectionHandlers;

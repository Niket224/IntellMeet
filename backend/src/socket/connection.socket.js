const { enforceSocketExpiry } = require("./auth.socket");
const registerMeetingHandlers = require("./meeting.socket");
const registerChatHandlers = require("./chat.socket");

function registerConnectionHandlers(io, presence, chatState) {
  io.on("connection", (socket) => {
    if (!enforceSocketExpiry(socket)) return;
    console.log(`Socket.IO connected: ${socket.id}`);
    const meeting = registerMeetingHandlers(io, socket, presence);
    registerChatHandlers(io, socket, meeting, chatState);

    socket.on("disconnect", (reason) => {
      console.log(`Socket.IO disconnected: ${socket.id} (${reason})`);
    });
  });
}

module.exports = registerConnectionHandlers;

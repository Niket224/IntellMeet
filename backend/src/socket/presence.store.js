function createPresenceStore() {
  const meetings = new Map();
  const sockets = new Map();
  let revision = 0;

  function snapshot(meetingId) {
    const meeting = meetings.get(meetingId);
    return {
      meetingId,
      revision: meeting ? meeting.revision : revision,
      participants: meeting
        ? [...meeting.users.entries()]
          .sort(([first], [second]) => first.localeCompare(second))
          .map(([userId, socketIds]) => ({ userId, socketIds: [...socketIds].sort() }))
        : []
    };
  }

  function getMembership(socketId) {
    const membership = sockets.get(socketId);
    return membership ? { meetingId: membership.meetingId, userId: membership.userId } : null;
  }

  function getMembershipRevision(socketId) {
    return sockets.get(socketId)?.joinedRevision ?? null;
  }

  function add(meetingId, userId, socketId) {
    const current = sockets.get(socketId);
    if (current) {
      if (current.meetingId === meetingId && current.userId === userId) return false;
      throw new Error("Socket already belongs to another meeting");
    }
    let meeting = meetings.get(meetingId);
    if (!meeting) {
      meeting = { users: new Map(), revision: 0 };
      meetings.set(meetingId, meeting);
    }
    let userSockets = meeting.users.get(userId);
    if (!userSockets) {
      userSockets = new Set();
      meeting.users.set(userId, userSockets);
    }
    userSockets.add(socketId);
    sockets.set(socketId, { meetingId, userId, joinedRevision: revision + 1 });
    meeting.revision = ++revision;
    return true;
  }

  function remove(socketId) {
    const current = sockets.get(socketId);
    if (!current) return null;
    sockets.delete(socketId);
    const meeting = meetings.get(current.meetingId);
    const userSockets = meeting.users.get(current.userId);
    userSockets.delete(socketId);
    if (userSockets.size === 0) meeting.users.delete(current.userId);
    meeting.revision = ++revision;
    const roster = snapshot(current.meetingId);
    if (meeting.users.size === 0) meetings.delete(current.meetingId);
    return roster;
  }

  return { add, remove, getMembership, getMembershipRevision, snapshot };
}

module.exports = createPresenceStore;

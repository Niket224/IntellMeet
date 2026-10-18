const locks = new Map();

async function withMeetingLock(meetingId, operation) {
  const previous = locks.get(meetingId) || Promise.resolve();

  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });

  const tail = previous.then(() => current);
  locks.set(meetingId, tail);

  await previous;

  try {
    return await operation();
  } finally {
    release();

    if (locks.get(meetingId) === tail) {
      locks.delete(meetingId);
    }
  }
}

module.exports = { withMeetingLock };
const { getIo } = require("../socket/io");
const { withMeetingLock } = require("../socket/meeting.lifecycle");

const mongoose = require("mongoose");
const Meeting = require("../models/Meeting");
const Workspace = require("../models/Workspace");

async function listMeetings(req, res, next) {
  try {
    const meetings = await Meeting.find({
      $or: [{ host: req.user._id }, { participants: req.user._id }]
    }).populate("host", "name email").populate("participants", "name email")
      .populate("workspace", "name");
    res.json({ meetings });
  } catch (error) {
    next(error);
  }
}

async function createMeeting(req, res, next) {
  try {
    const { title, description = "", scheduledAt = null, workspace = null } = req.body;
    if (!title || !String(title).trim()) {
      return res.status(400).json({ message: "Meeting title is required" });
    }

    if (workspace) {
      if (!mongoose.isValidObjectId(workspace)) {
        return res.status(400).json({ message: "Invalid workspace ID" });
      }
      const memberWorkspace = await Workspace.findOne({
        _id: workspace,
        members: req.user._id
      });
      if (!memberWorkspace) {
        return res.status(403).json({ message: "You must be a workspace member to schedule a meeting there" });
      }
    }

    const meeting = await Meeting.create({
      title: String(title).trim(),
      description,
      host: req.user._id,
      participants: [req.user._id],
      workspace,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null
    });
    await meeting.populate("host", "name email");
    await meeting.populate("participants", "name email");
    res.status(201).json({ meeting });
  } catch (error) {
    next(error);
  }
}

async function getMeeting(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid meeting ID" });
    }
    const meeting = await Meeting.findOne({
      _id: req.params.id,
      $or: [{ host: req.user._id }, { participants: req.user._id }]
    }).populate("host", "name email").populate("participants", "name email")
      .populate("workspace", "name");

    if (!meeting) return res.status(404).json({ message: "Meeting not found" });
    res.json({ meeting });
  } catch (error) {
    next(error);
  }
}

async function joinMeeting(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid meeting ID" });
    }
    const meeting = await Meeting.findById(req.params.id);
    if (!meeting) return res.status(404).json({ message: "Meeting not found" });
    if (meeting.status === "ended") {
      return res.status(400).json({ message: "This meeting has already ended" });
    }

    if (meeting.workspace) {
      const workspace = await Workspace.findOne({
        _id: meeting.workspace,
        members: req.user._id
      });
      if (!workspace && String(meeting.host) !== String(req.user._id)) {
        return res.status(403).json({ message: "You are not a member of this meeting's workspace" });
      }
    }

    if (!meeting.participants.some((id) => String(id) === String(req.user._id))) {
      meeting.participants.push(req.user._id);
    }
    if (meeting.status === "scheduled") {
      meeting.status = "live";
      meeting.startedAt = new Date();
    }
    await meeting.save();
    await meeting.populate("host", "name email");
    await meeting.populate("participants", "name email");
    res.json({ message: "Joined meeting", meeting });
  } catch (error) {
    next(error);
  }
}

async function endMeeting(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid meeting ID" });
    }

    const meetingId = req.params.id.toLowerCase();

    await withMeetingLock(meetingId, async () => {
      const meeting = await Meeting.findOne({
        _id: meetingId,
        host: req.user._id
      });

      if (!meeting) {
        const error = new Error("Meeting not found or you are not the host");
        error.status = 404;
        throw error;
      }

      if (meeting.status !== "ended") {
        meeting.status = "ended";
        meeting.endedAt = new Date();
        await meeting.save();
      }

      const io = getIo();
      const room = `meeting:${meetingId}`;

      io.to(room).emit("meeting:ended", {
        meetingId,
        message: "The host has ended this meeting"
      });

      // Remove sockets from the meeting room without disconnecting them.
      // They can still receive MEETING_ENDED acknowledgments.
      await io.in(room).socketsLeave(room);

      return meeting;
    });

    res.json({ message: "Meeting ended" });
  } catch (error) {
    if (error.status === 404) {
      return res.status(404).json({ message: error.message });
    }
    next(error);
  }
}

module.exports = {
  listMeetings,
  createMeeting,
  getMeeting,
  joinMeeting,
  endMeeting
};

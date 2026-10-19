const Meeting = require("../models/Meeting");
const { getIo } = require("../socket/io");
const mongoose = require("mongoose");
const Workspace = require("../models/Workspace");

async function listWorkspaces(req, res, next) {
  try {
    const workspaces = await Workspace.find({ members: req.user._id })
      .populate("owner", "name email")
      .populate("members", "name email");
    res.json({ workspaces });
  } catch (error) {
    next(error);
  }
}

async function createWorkspace(req, res, next) {
  try {
    const { name, description = "" } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: "Workspace name is required" });
    }

    const workspace = await Workspace.create({
      name: String(name).trim(),
      description,
      owner: req.user._id,
      members: [req.user._id]
    });
    await workspace.populate("owner", "name email");
    await workspace.populate("members", "name email");
    res.status(201).json({ workspace });
  } catch (error) {
    next(error);
  }
}

async function getWorkspace(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid workspace ID" });
    }
    const workspace = await Workspace.findOne({
      _id: req.params.id,
      members: req.user._id
    }).populate("owner", "name email").populate("members", "name email");

    if (!workspace) return res.status(404).json({ message: "Workspace not found" });
    res.json({ workspace });
  } catch (error) {
    next(error);
  }
}


async function removeWorkspaceMember(req, res, next) {
  try {
    const { id, userId } = req.params;

    if (
      !mongoose.isValidObjectId(id) ||
      !mongoose.isValidObjectId(userId)
    ) {
      return res.status(400).json({
        message: "Invalid workspace or user ID"
      });
    }

    const workspace = await Workspace.findById(id);

    if (!workspace) {
      return res.status(404).json({
        message: "Workspace not found"
      });
    }

    if (String(workspace.owner) !== String(req.user._id)) {
      return res.status(403).json({
        message: "Only the workspace owner can remove members"
      });
    }

    if (String(workspace.owner) === String(userId)) {
      return res.status(400).json({
        message: "The workspace owner cannot be removed"
      });
    }

    const isMember = workspace.members.some(
      (memberId) => String(memberId) === String(userId)
    );

    if (!isMember) {
      return res.status(404).json({
        message: "User is not a member of this workspace"
      });
    }

    workspace.members = workspace.members.filter(
      (memberId) => String(memberId) !== String(userId)
    );

    await workspace.save();
    const io = getIo();

const meetings = await Meeting.find({
  workspace: workspace._id,
  status: { $ne: "ended" },
  $or: [
    { participants: userId },
    { host: userId }
  ]
}).select("_id");

for (const meeting of meetings) {
  const room = `meeting:${meeting._id}`;
  const sockets = await io.in(room).fetchSockets();

  for (const socket of sockets) {
    if (String(socket.data.user?.id) !== String(userId)) {
      continue;
    }

    socket.emit("workspace:access-revoked", {
      workspaceId: String(workspace._id),
      meetingId: String(meeting._id),
      message: "Your access to this workspace has been revoked"
    });

    socket.disconnect(true);
  }
}

    res.json({
      message: "Workspace member removed successfully",
      workspaceId: String(workspace._id),
      userId: String(userId)
    });
  } catch (error) {
    next(error);
  }
}



module.exports = {
  listWorkspaces,
  createWorkspace,
  getWorkspace,
  removeWorkspaceMember
};

const mongoose = require("mongoose");
const ActionItem = require("../models/ActionItem");
const Meeting = require("../models/Meeting");
const Workspace = require("../models/Workspace");

async function listActionItems(req, res, next) {
  try {
    const items = await ActionItem.find({
      $or: [{ createdBy: req.user._id }, { assignee: req.user._id }]
    }).populate("createdBy", "name email").populate("assignee", "name email")
      .populate("meeting", "title").populate("workspace", "name");
    res.json({ actionItems: items });
  } catch (error) {
    next(error);
  }
}

async function createActionItem(req, res, next) {
  try {
    const { title, description = "", meeting = null, workspace = null,
      assignee = null, dueDate = null, priority = "medium" } = req.body;

    if (!title || !String(title).trim()) {
      return res.status(400).json({ message: "Action item title is required" });
    }
    if (!["low", "medium", "high"].includes(priority)) {
      return res.status(400).json({ message: "Invalid priority" });
    }

    if (meeting) {
      if (!mongoose.isValidObjectId(meeting)) return res.status(400).json({ message: "Invalid meeting ID" });
      const accessibleMeeting = await Meeting.findOne({
        _id: meeting,
        $or: [{ host: req.user._id }, { participants: req.user._id }]
      });
      if (!accessibleMeeting) return res.status(403).json({ message: "You cannot add tasks to this meeting" });
    }
    if (workspace) {
      if (!mongoose.isValidObjectId(workspace)) return res.status(400).json({ message: "Invalid workspace ID" });
      const accessibleWorkspace = await Workspace.findOne({ _id: workspace, members: req.user._id });
      if (!accessibleWorkspace) return res.status(403).json({ message: "You are not a workspace member" });
    }
    if (assignee && !mongoose.isValidObjectId(assignee)) {
      return res.status(400).json({ message: "Invalid assignee ID" });
    }

    const item = await ActionItem.create({
      title: String(title).trim(), description, meeting, workspace,
      createdBy: req.user._id, assignee, dueDate: dueDate || null, priority
    });
    await item.populate("createdBy", "name email");
    await item.populate("assignee", "name email");
    res.status(201).json({ actionItem: item });
  } catch (error) {
    next(error);
  }
}

async function updateActionItem(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid action item ID" });
    }
    const item = await ActionItem.findOne({
      _id: req.params.id,
      $or: [{ createdBy: req.user._id }, { assignee: req.user._id }]
    });
    if (!item) return res.status(404).json({ message: "Action item not found" });

    const fields = ["title", "description", "assignee", "dueDate", "status", "priority"];
    for (const field of fields) {
      if (req.body[field] !== undefined) item[field] = req.body[field];
    }
    await item.save();
    await item.populate("createdBy", "name email");
    await item.populate("assignee", "name email");
    res.json({ actionItem: item });
  } catch (error) {
    next(error);
  }
}

module.exports = { listActionItems, createActionItem, updateActionItem };

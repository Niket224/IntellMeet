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

module.exports = { listWorkspaces, createWorkspace, getWorkspace };

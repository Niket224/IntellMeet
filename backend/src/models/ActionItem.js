const mongoose = require("mongoose");

const actionItemSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 240 },
    description: { type: String, default: "", maxlength: 2000 },
    meeting: { type: mongoose.Schema.Types.ObjectId, ref: "Meeting", default: null },
    workspace: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    assignee: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    dueDate: { type: Date, default: null },
    status: {
      type: String,
      enum: ["todo", "in_progress", "completed"],
      default: "todo"
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium"
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("ActionItem", actionItemSchema);

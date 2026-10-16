const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254
    },
    password: { type: String, required: true, select: false },
    avatarUrl: { type: String, default: "" },
    jobTitle: { type: String, default: "", maxlength: 100 }
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);

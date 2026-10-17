const express = require("express");
const cors = require("cors");
const createCorsOptions = require("./config/cors");

const authRoutes = require("./routes/auth.routes");
const userRoutes = require("./routes/user.routes");
const workspaceRoutes = require("./routes/workspace.routes");
const meetingRoutes = require("./routes/meeting.routes");
const actionItemRoutes = require("./routes/actionItem.routes");
const { notFound, errorHandler } = require("./middleware/error.middleware");

const app = express();

app.use(cors(createCorsOptions()));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.json({ message: "IntelliMeet API is running" });
});
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "intellimeet-backend" });
});

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/workspaces", workspaceRoutes);
app.use("/api/meetings", meetingRoutes);
app.use("/api/action-items", actionItemRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;

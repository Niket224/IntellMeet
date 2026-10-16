const express = require("express");
const { listWorkspaces, createWorkspace, getWorkspace } = require("../controllers/workspace.controller");
const { protect } = require("../middleware/auth.middleware");

const router = express.Router();
router.use(protect);
router.get("/", listWorkspaces);
router.post("/", createWorkspace);
router.get("/:id", getWorkspace);

module.exports = router;

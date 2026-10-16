const express = require("express");
const { listActionItems, createActionItem, updateActionItem } = require("../controllers/actionItem.controller");
const { protect } = require("../middleware/auth.middleware");

const router = express.Router();
router.use(protect);
router.get("/", listActionItems);
router.post("/", createActionItem);
router.patch("/:id", updateActionItem);

module.exports = router;

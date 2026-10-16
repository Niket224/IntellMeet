const express = require("express");
const { listMeetings, createMeeting, getMeeting, joinMeeting, endMeeting } = require("../controllers/meeting.controller");
const { protect } = require("../middleware/auth.middleware");

const router = express.Router();
router.use(protect);
router.get("/", listMeetings);
router.post("/", createMeeting);
router.get("/:id", getMeeting);
router.post("/:id/join", joinMeeting);
router.patch("/:id/end", endMeeting);

module.exports = router;

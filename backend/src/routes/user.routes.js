const express = require("express");
const { getMe, updateMe } = require("../controllers/user.controller");
const { protect } = require("../middleware/auth.middleware");

const router = express.Router();
router.use(protect);
router.get("/me", getMe);
router.patch("/me", updateMe);

module.exports = router;

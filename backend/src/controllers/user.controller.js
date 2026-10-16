async function getMe(req, res) {
  res.json({
    user: {
      id: req.user._id,
      name: req.user.name,
      email: req.user.email,
      avatarUrl: req.user.avatarUrl,
      jobTitle: req.user.jobTitle,
      createdAt: req.user.createdAt
    }
  });
}

async function updateMe(req, res, next) {
  try {
    const allowedFields = ["name", "avatarUrl", "jobTitle"];
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        req.user[field] = req.body[field];
      }
    }

    await req.user.save();
    res.json({
      message: "Profile updated",
      user: {
        id: req.user._id,
        name: req.user.name,
        email: req.user.email,
        avatarUrl: req.user.avatarUrl,
        jobTitle: req.user.jobTitle
      }
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { getMe, updateMe };

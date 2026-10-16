function notFound(req, res, next) {
  res.status(404);
  next(new Error(`Route not found: ${req.method} ${req.originalUrl}`));
}

function errorHandler(err, req, res, next) {
  const statusCode = res.statusCode >= 400 ? res.statusCode : 500;
  const message =
    err.name === "ValidationError"
      ? Object.values(err.errors).map((item) => item.message).join(", ")
      : err.code === 11000
      ? "A record with that unique value already exists"
      : err.name === "CastError"
      ? "Invalid ID format"
      : err.message || "Internal server error";

  res.status(statusCode).json({
    message,
    ...(process.env.NODE_ENV === "development" ? { stack: err.stack } : {})
  });
}

module.exports = { notFound, errorHandler };

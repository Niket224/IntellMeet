function createCorsOptions() {
  const allowedOrigins = (process.env.CLIENT_URL || "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim());

  return {
    origin(origin, callback) {
      // Permit tools without an Origin header and configured frontend origins.
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Origin not allowed by CORS"));
    },
    credentials: true
  };
}

module.exports = createCorsOptions;

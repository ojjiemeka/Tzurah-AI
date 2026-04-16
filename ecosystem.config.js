// PM2 ecosystem config for Tzurah Live GCP server
module.exports = {
  apps: [{
    name:        "tzurah-server",
    script:      "gcp-server.js",
    instances:   1,
    autorestart: true,
    watch:       false,
    max_memory_restart: "500M",
    env_production: {
      NODE_ENV: "production",
      PORT:     4000,
    },
    error_file:      "./logs/error.log",
    out_file:        "./logs/out.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
  }],
};

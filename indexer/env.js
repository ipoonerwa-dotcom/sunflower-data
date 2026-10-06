"use strict";
/** Loads .env into process.env without a dependency. Existing variables win, so a shell override
 *  always beats the file. Tolerates CRLF, blank lines, comments and `=` inside values (URLs). */
const fs = require("fs");
const path = require("path");

function loadEnv(file = path.join(__dirname, "..", ".env")) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const split = line.indexOf("=");
    if (split < 1) continue;
    const key = line.slice(0, split).trim();
    if (!process.env[key]) process.env[key] = line.slice(split + 1).trim();
  }
}

module.exports = { loadEnv };

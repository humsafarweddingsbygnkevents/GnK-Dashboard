'use strict';

// Vercel serverless entrypoint. An Express app is itself a valid
// (req, res) => void handler, so exporting it directly is sufficient —
// no adapter needed.
module.exports = require('../backend/src/app');

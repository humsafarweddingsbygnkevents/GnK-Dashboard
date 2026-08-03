'use strict';

// Local dev entrypoint only — `npm start` / `npm run dev`. On Vercel, the
// same Express app (src/app.js) is imported directly by api/index.js as a
// serverless function handler; nothing here runs in production.
const app = require('./app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Humsafar Weddings by GnK API + Dashboard running on http://localhost:${PORT}`);
});

// Vercel serverless entry point — the Express app with Blob-backed SQLite
// persistence (see server.js). All routes (static + /api) are rewritten here.
const app = require('../server');

module.exports = app;

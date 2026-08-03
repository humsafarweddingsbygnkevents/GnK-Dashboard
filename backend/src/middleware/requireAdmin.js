'use strict';

// Must run after requireAuth. Blocks employee sessions from admin-only data.
module.exports = function requireAdmin(req, res, next) {
  if (req.admin?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
};

import express from 'express';
import cors from 'cors';
import publicRoutes from './routes/public.js';
import studentRoutes from './routes/student.js';
import staffRoutes from './routes/staff.js';
import studentApplicationRoutes from './routes/studentApplication.js';
import staffApplicationRoutes from './routes/staffApplication.js';
import systemRoutes from './routes/system.js';

export function createApp() {
  const app = express();
  app.use(cors({ origin: process.env.APP_URL || 'http://localhost:5173' }));
  app.use(express.json({ limit: '50kb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', systemRoutes);
  app.use('/api/student', studentRoutes);
  app.use('/api/student', studentApplicationRoutes);
  app.use('/api/staff', staffRoutes);
  app.use('/api/staff', staffApplicationRoutes);
  app.use('/api', publicRoutes);

  app.use('/api', (_req, res) => res.status(404).json({ message: 'Not found.' }));

  // Errors: known ones keep their status and message; anything else is logged
  // and answered without internal details.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ message: 'That file is too large. The limit is 10 MB.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid request.' });
    if (err.status && err.status < 500) {
      return res.status(err.status).json({ message: err.message, ...(err.extra || {}) });
    }
    console.error(err);
    return res.status(500).json({ message: 'Something went wrong. Please try again.' });
  });

  return app;
}

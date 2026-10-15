// Vercel entry point: every /api/... request is sent here (see vercel.json)
// and handled by the same Express app that runs locally.
import { createApp } from '../server/src/app.js';

export default createApp();

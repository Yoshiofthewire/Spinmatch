import { Router } from 'express';
import { paging } from '../lib/paging.js';
import { listHistory, clearHistory, importHistory } from '../services/verifyHistory.js';

export const historyRouter = Router();

historyRouter.get('/', (req, res) => {
  const { limit, offset } = paging(req, 50);
  res.json({ ...listHistory({ limit, offset }), limit, offset });
});

historyRouter.delete('/', (req, res) => {
  res.json({ cleared: clearHistory() });
});

historyRouter.post('/import', (req, res) => {
  res.json(importHistory(req.body?.entries));
});

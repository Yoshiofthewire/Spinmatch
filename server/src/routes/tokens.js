import { Router } from 'express';
import { getDb } from '../lib/db.js';
import { createToken, listTokens, revokeToken, revokeAllTokens } from '../services/apiTokens.js';
import { BadRequestError, NotFoundError } from '../lib/httpErrors.js';

// Mounted behind sessionOnly: a token can never mint, list or revoke tokens.
export const tokensRouter = Router();

tokensRouter.get('/', (req, res) => {
  res.json({ tokens: listTokens(getDb()) });
});

tokensRouter.post('/', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (name.length < 1 || name.length > 64) throw new BadRequestError('A token name is 1-64 characters');
  const scope = req.body?.scope ?? 'read';
  if (scope !== 'read' && scope !== 'full') throw new BadRequestError("scope must be 'read' or 'full'");
  res.set('Cache-Control', 'no-store');
  res.json(createToken(getDb(), { name, scope }));
});

tokensRouter.delete('/', (req, res) => {
  res.json({ revoked: revokeAllTokens(getDb()) });
});

tokensRouter.delete('/:id', (req, res) => {
  if (!revokeToken(getDb(), Number(req.params.id))) throw new NotFoundError('No such token');
  res.json({ ok: true });
});

import { Router } from 'express';
import {
  config, ingestEnabled, libraryEnabled, playlistExportEnabled,
} from '../config.js';
import { getDb } from '../lib/db.js';
import { adminExists, sessionFromToken } from '../services/auth.js';
import { SESSION_COOKIE } from '../middleware/requireAuth.js';
import { parseCookies } from '../lib/cookies.js';

export const configRouter = Router();

// This route is deliberately public — the client needs it before it can render
// anything, including the login screen. That makes what it returns visible to
// anyone who can reach the port, so the payload is split.
//
// metubeUrl in particular is usually an internal hostname (http://10.0.0.5:8081)
// and was being handed to unauthenticated callers, which is a free map of the
// operator's network. It is not needed until a track row is rendered, which is
// well past the login gate, so it now requires a session. The feature flags stay
// public: the client uses them to decide which nav entries exist, and they say
// nothing an attacker can act on.
configRouter.get('/', (req, res) => {
  const db = getDb();
  const authenticated = adminExists(db)
    && Boolean(sessionFromToken(db, parseCookies(req.headers.cookie)[SESSION_COOKIE]));

  res.json({
    ingestEnabled: ingestEnabled(),
    libraryEnabled: libraryEnabled(),
    playlistExportEnabled: playlistExportEnabled(),
    acoustidConfigured: Boolean(config.acoustidApiKey),
    // Present only for a logged-in caller; `null` reads to the client exactly
    // like "MeTube isn't configured", which hides the button either way.
    metubeUrl: authenticated ? config.metubeUrl : null,
  });
});

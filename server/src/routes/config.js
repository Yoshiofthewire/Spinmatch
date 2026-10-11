import { Router } from 'express';
import {
  config, ingestEnabled, libraryEnabled, playlistExportEnabled,
} from '../config.js';

export const configRouter = Router();

// Public: the client needs these flags before login, so nothing secret goes here.
configRouter.get('/', (req, res) => {
  res.json({
    ingestEnabled: ingestEnabled(),
    libraryEnabled: libraryEnabled(),
    playlistExportEnabled: playlistExportEnabled(),
    acoustidConfigured: Boolean(config.acoustidApiKey),
  });
});

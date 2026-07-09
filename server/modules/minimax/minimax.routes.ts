import express from 'express';

import { minimaxService } from '@/modules/minimax/minimax.service.js';

const router = express.Router();

router.get('/status', async (_req, res) => {
  try {
    res.json({ success: true, data: await minimaxService.getStatus() });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load MiniMax status.',
    });
  }
});

router.get('/settings', async (_req, res) => {
  try {
    res.json({ success: true, data: { settings: await minimaxService.getSettings() } });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load MiniMax settings.',
    });
  }
});

router.put('/settings', async (req, res) => {
  try {
    const settings = await minimaxService.updateSettings(req.body || {});
    res.json({ success: true, data: { settings } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save MiniMax settings.',
    });
  }
});

// Quota snapshot from the `mmx` CLI. Pass `?force=1` to bypass the in-process
// 60s cache (used by the manual Refresh button in the UI).
router.get('/usage', async (req, res) => {
  try {
    const force = req.query.force === '1';
    const data = await minimaxService.getUsage({ force });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load MiniMax usage.',
    });
  }
});

// Returns the credentials the `mmx` CLI currently has configured. The UI
// uses this to render a status card (authenticated / not installed /
// needs login) instead of an editable form. The user manages the key
// with `mmx auth login` on the server, not through this API.
router.get('/credentials', async (req, res) => {
  try {
    const force = req.query.force === '1';
    const data = await minimaxService.getMmxCredentials({ force });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load MiniMax credentials.',
    });
  }
});

export default router;

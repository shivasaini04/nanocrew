import { Router } from 'express';
import {
  getModelConfig,
  saveModelConfig,
  loadModelConfig,
  type ModelConfig,
} from '../../services/model-router.js';

const router = Router();

router.get('/model-config', (_req, res) => {
  res.json(getModelConfig());
});

router.put('/model-config', (req, res) => {
  const body = req.body as Partial<ModelConfig>;
  const current = getModelConfig();
  const updated: ModelConfig = {
    defaultModel: body.defaultModel ?? current.defaultModel,
    fallbackChain: Array.isArray(body.fallbackChain)
      ? body.fallbackChain
      : current.fallbackChain,
    thinkingDefault:
      typeof body.thinkingDefault === 'boolean'
        ? body.thinkingDefault
        : current.thinkingDefault,
    taskModels:
      body.taskModels && typeof body.taskModels === 'object'
        ? body.taskModels
        : current.taskModels,
  };
  saveModelConfig(updated);
  res.json(updated);
});

// Force a reload from disk (e.g. after external edit)
router.post('/model-config/reload', (_req, res) => {
  const config = loadModelConfig();
  res.json(config);
});

export { router as modelConfigRouter };

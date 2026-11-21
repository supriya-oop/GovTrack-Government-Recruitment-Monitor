import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cron from 'node-cron';
import { db } from './server/db.ts';
import { seedDatabase } from './server/seed.ts';
import { createApiRouter, schedulerConfig } from './server/routes.ts';
import { runSourceScrape } from './server/scraperEngine.ts';

async function startServer() {
  await seedDatabase();

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.use('/api', createApiRouter());

  // Periodic background scheduler
  cron.schedule('0 */6 * * *', async () => {
    if (!schedulerConfig.enabled) return;
    try {
      const sources = db
        .prepare('SELECT * FROM monitoring_sources WHERE is_active = 1 ORDER BY id ASC')
        .all() as Record<string, unknown>[];
      for (const src of sources) {
        await runSourceScrape(src, { triggerType: 'scheduler', modeOverride: 'live' });
      }
      schedulerConfig.lastRunAt = new Date().toISOString();
    } catch (err) {
      console.error('[Scheduler] Failed periodic scrape:', err);
    }
  });

  const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(path.resolve(process.cwd(), 'dist', 'index.html'));
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`GovTrack Full-Stack Server listening on http://0.0.0.0:${PORT}`);

    // If database only contains offline seed baseline rows, hydrate reachable portals with live official data
    setImmediate(async () => {
      try {
        const liveRow = db
          .prepare('SELECT COUNT(*) as cnt FROM recruitment_notifications WHERE is_removed = 0 AND is_demo_data = 0')
          .get() as { cnt: number };
        if (Number(liveRow?.cnt || 0) === 0) {
          console.log('[Startup Live Sync] Hydrating reachable government portals with live official notifications...');
          const sources = db
            .prepare('SELECT * FROM monitoring_sources WHERE is_active = 1 ORDER BY id ASC')
            .all() as Record<string, unknown>[];
          for (const src of sources) {
            await runSourceScrape(src, {
              triggerType: 'startup_live_sync',
              modeOverride: 'live',
              suppressHistory: true,
              replaceDemoWithLive: true,
            });
          }
          schedulerConfig.lastRunAt = new Date().toISOString();
          console.log('[Startup Live Sync] Live portal hydration complete.');
        }
      } catch (err) {
        console.error('[Startup Live Sync] Error:', err);
      }
    });
  });
}

startServer().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

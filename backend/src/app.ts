import express from "express";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";

import { env } from "./infrastructure/config/env";
import { prisma } from "./infrastructure/database/prisma";
import { requestId } from "./shared/middleware/requestId";
import { requestLogger } from "./shared/middleware/requestLogger";
import { notFoundHandler, errorHandler } from "./shared/middleware/errorHandler";
import authRoutes from "./modules/auth/auth.routes";

/**
 * Builds the Express app. Note there is no .listen() here — that lives in
 * server.ts. Keeping them apart means tests can import this app and call it
 * directly, with no port to bind and no port to clash.
 *
 * Middleware order below is not cosmetic: Express runs them top to bottom for
 * every request, so each one only sees what the ones above already did.
 */
const app = express();

// 1. Security headers first, so even a request that dies early gets them.
app.use(helmet());

// 2. CORS. Explicit origin list from env, never "*" — "*" lets any website
//    call this API from a user's browser.
app.use(cors({ origin: env.CORS_ORIGINS, credentials: true }));

// 3. Parse JSON bodies. The size limit stops someone posting a 500MB body
//    and eating all the server's memory.
app.use(express.json({ limit: "100kb" }));

// 4. Gzip responses.
app.use(compression());

// 5. Request id, then 6. logging — logging needs the id, so id goes first.
app.use(requestId);
app.use(requestLogger);

// 7. Health check. Used by Docker/hosting to ask "is this process alive AND
//    can it still reach the database?" A process that is up but cannot query
//    is not healthy, so we run the cheapest possible query.
app.get("/health", async (_req, res) => {
  let database = "up";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    database = "down";
  }

  res.status(database === "up" ? 200 : 503).json({
    status: database === "up" ? "ok" : "degraded",
    uptime: process.uptime(),
    database,
  });
});

// 8. Feature routers, versioned from day one. Adding /v2 later beats renaming
//    every URL after the Flutter app has shipped.
app.use("/api/v1/auth", authRoutes);

// 9. Nothing matched above -> our own 404 shape, not Express' HTML page.
app.use(notFoundHandler);

// 10. Error handler LAST. Express only treats a function as an error handler
//     because it takes four arguments, and only reaches it after everything else.
app.use(errorHandler);

export default app;

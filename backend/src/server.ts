import app from "./app";
import { env } from "./infrastructure/config/env";
import { prisma } from "./infrastructure/database/prisma";

const server = app.listen(env.PORT, () => {
  console.log(`Server listening on http://localhost:${env.PORT}`);
});

/**
 * Graceful shutdown.
 *
 * When you press Ctrl+C (SIGINT) or a host stops the container (SIGTERM), the
 * default is to kill the process instantly: in-flight requests die and the
 * database connections are left dangling. Instead we stop accepting new
 * connections, let the current ones finish, then close Prisma's pool.
 */
async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down...`);

  server.close(async () => {
    await prisma.$disconnect();
    console.log("Closed cleanly");
    process.exit(0);
  });

  // ponytail: fixed 10s force-quit; make it configurable if a request ever
  // legitimately takes longer than that.
  setTimeout(() => {
    console.error("Shutdown timed out, forcing exit");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

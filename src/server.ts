import { app } from "./app.js";
import { config } from "./config.js";
import { prisma } from "./db.js";

const server = app.listen(config.PORT, "0.0.0.0", () => {
  console.log(`RWExec Licensing API listening on port ${config.PORT}`);
});

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down...`);

  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

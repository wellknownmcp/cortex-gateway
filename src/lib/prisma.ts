import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prismaCortex: PrismaClient | undefined;
};

/** True when a database is configured — persistence features are optional. */
export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.CORTEX_DATABASE_URL);
}

/**
 * Lazy singleton: the client is only instantiated on first use, so the
 * gateway boots fine without CORTEX_DATABASE_URL (audit stays on stdout,
 * gateway-local tickets are disabled). Guard call sites with
 * `isDatabaseConfigured()`.
 */
export function getPrismaCortex(): PrismaClient {
  if (!globalForPrisma.prismaCortex) {
    globalForPrisma.prismaCortex = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    });
  }
  return globalForPrisma.prismaCortex;
}

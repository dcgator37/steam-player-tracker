import "dotenv/config";

const allowedSameSiteValues =
  new Set([
    "lax",
    "strict",
    "none"
  ]);

const requestedSameSite =
  String(
    process.env.ADMIN_COOKIE_SAME_SITE ||
    "lax"
  ).toLowerCase();

export const config = {
  port: Number(process.env.PORT || 3000),

  steamApiKey: process.env.STEAM_API_KEY,

  databaseUrl: process.env.DATABASE_URL,

   frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",

  collectCron: process.env.COLLECT_CRON || "*/15 * * * *",

  runOnStartup:
    String(process.env.RUN_ON_STARTUP || "true").toLowerCase() === "true",

    adminPasswordHash:
    process.env.ADMIN_PASSWORD_HASH,

  adminSessionHours:
    Math.max(
      Number(
        process.env.ADMIN_SESSION_HOURS ||
        12
      ),
      1
    ),

  adminCookieSecure:
    String(
      process.env.ADMIN_COOKIE_SECURE ||
      "false"
    ).toLowerCase() === "true",

  adminCookieSameSite:
    allowedSameSiteValues.has(
      requestedSameSite
    )
      ? requestedSameSite
      : "lax",

  friendCrawlDelayMs:
  Number(
    process.env.FRIEND_CRAWL_DELAY_MS ||
    500
  ),

  friendCrawlDefaultDepth:
  Number(
    process.env.FRIEND_CRAWL_DEFAULT_DEPTH ||
    2
  ),

  friendCrawlMaxProfiles:
  Number(
    process.env.FRIEND_CRAWL_MAX_PROFILES ||
    2000
  ),

  friendCrawlBatchSize:
  Number(
    process.env.FRIEND_CRAWL_BATCH_SIZE ||
    10
  ),

  profileQueueBatchSize:
  Number(
    process.env.PROFILE_QUEUE_BATCH_SIZE ||
    20
  ),

profileQueueConcurrency:
  Number(
    process.env.PROFILE_QUEUE_CONCURRENCY ||
    2
  ),

profileQueueDelayMs:
  Number(
    process.env.PROFILE_QUEUE_DELAY_MS ||
    750
  ),

profileQueueMaxAttempts:
  Number(
    process.env.PROFILE_QUEUE_MAX_ATTEMPTS ||
    3
  ),

profileQueueRetryDelaySeconds:
  Number(
    process.env.PROFILE_QUEUE_RETRY_DELAY_SECONDS ||
    60
  ),

profileQueueStaleMinutes:
  Number(
    process.env.PROFILE_QUEUE_STALE_MINUTES ||
    15
  )
};

if (!config.steamApiKey) {
  console.warn("WARNING: STEAM_API_KEY is not configured.");
}

if (!config.databaseUrl) {
  throw new Error("DATABASE_URL is not configured.");
}
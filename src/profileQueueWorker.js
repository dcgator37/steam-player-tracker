import { pool } from "./db.js";
import { config } from "./config.js";

import {
  collectProfile
} from "./profileCollector.js";
import { refreshDashboardStatistics } from "./dashboardStatistics.js";
import { refreshProfileSpotlights } from "./profileStatistics.js";


function sleep(milliseconds) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        milliseconds
      )
  );
}

async function resetStaleProcessing() {

  const result =
    await pool.query(
      `
        UPDATE steam_profile_queue

        SET
          status = 'pending',

          next_attempt_at = NOW(),

          error_message =
            'Recovered stale processing job.'

        WHERE status = 'processing'

          AND last_attempt_at <
            NOW() -
            ($1 * INTERVAL '1 minute')

        RETURNING steamid
      `,
      [
        config.profileQueueStaleMinutes
      ]
    );


  if (
    result.rows.length > 0
  ) {

    console.log(
      `Recovered ${result.rows.length} ` +
      `stale profile queue jobs.`
    );
  }


  return result.rows.length;
}

async function claimNextProfile() {

  const client =
    await pool.connect();


  try {

    await client.query(
      "BEGIN"
    );


    const result =
      await client.query(
        `
          SELECT
            steamid,
            attempts

          FROM steam_profile_queue

          WHERE status = 'pending'

            AND next_attempt_at <= NOW()

            AND attempts < $1

          ORDER BY
            discovered_at,
            steamid

          LIMIT 1

          FOR UPDATE
          SKIP LOCKED
        `,
        [
          config.profileQueueMaxAttempts
        ]
      );


    if (
      result.rows.length === 0
    ) {

      await client.query(
        "COMMIT"
      );

      return null;
    }


    const item =
      result.rows[0];


    const updateResult =
      await client.query(
        `
          UPDATE steam_profile_queue

          SET
            status = 'processing',

            attempts =
              attempts + 1,

            last_attempt_at =
              NOW(),

            error_message =
              NULL

          WHERE steamid = $1

          RETURNING
            steamid,
            attempts,
            discovered_at
        `,
        [
          item.steamid
        ]
      );


    await client.query(
      "COMMIT"
    );


    return (
      updateResult.rows[0] ??
      null
    );


  } catch (error) {

    await client.query(
      "ROLLBACK"
    );

    throw error;


  } finally {

    client.release();
  }
}

async function markCompleted(
  steamid
) {

  await pool.query(
    `
      UPDATE steam_profile_queue

      SET
        status =
          'completed',

        completed_at =
          NOW(),

        error_message =
          NULL

      WHERE steamid = $1
    `,
    [
      steamid
    ]
  );
}

async function markGameDetailsPrivate(
  steamid
) {

  await pool.query(
    `
      UPDATE steam_profile_queue

      SET
        status =
          'game_details_private',

        completed_at =
          NOW(),

        error_message =
          NULL

      WHERE steamid = $1
    `,
    [
      steamid
    ]
  );
}

async function markPlaytimeUnavailable(
  steamid
) {

  await pool.query(
    `
      UPDATE steam_profile_queue

      SET
        status =
          'playtime_unavailable',

        completed_at =
          NOW(),

        error_message =
          NULL

      WHERE steamid = $1
    `,
    [
      steamid
    ]
  );
}

async function markNotFound(
  steamid
) {

  await pool.query(
    `
      UPDATE steam_profile_queue

      SET
        status =
          'not_found',

        completed_at =
          NOW(),

        error_message =
          'Steam profile was not found.'

      WHERE steamid = $1
    `,
    [
      steamid
    ]
  );
}

async function retryOrFail(
  steamid,
  errorMessage
) {

  const result =
    await pool.query(
      `
        SELECT attempts

        FROM steam_profile_queue

        WHERE steamid = $1
      `,
      [
        steamid
      ]
    );


  if (
    result.rows.length === 0
  ) {

    return "failed";
  }


  const attempts =
    Number(
      result.rows[0].attempts
    );


  /*
   * We've exhausted our retries.
   */
  if (
    attempts >=
    config.profileQueueMaxAttempts
  ) {

    await pool.query(
      `
        UPDATE steam_profile_queue

        SET
          status =
            'failed',

          completed_at =
            NOW(),

          error_message =
            $2

        WHERE steamid = $1
      `,
      [
        steamid,
        errorMessage
      ]
    );


    return "failed";
  }


  /*
   * Otherwise put it back into the queue,
   * but don't make it eligible immediately.
   */
  await pool.query(
    `
      UPDATE steam_profile_queue

      SET
        status =
          'pending',

        next_attempt_at =
          NOW() +
          (
            $2 *
            INTERVAL '1 second'
          ),

        error_message =
          $3

      WHERE steamid = $1
    `,
    [
      steamid,

      config
        .profileQueueRetryDelaySeconds,

      errorMessage
    ]
  );


  return "retry";
}

async function processProfile(
  item
) {

  const steamid =
    item.steamid;


  console.log(
    `Processing Steam profile ${steamid} ` +
    `(attempt ${item.attempts})...`
  );


  try {

    const result =
      await collectProfile(
        steamid
      );


    /*
     * Game library exists and was saved.
     */
    if (
      result.gamesVisible && result.playtimeAvailable === true
    ) {

      await markCompleted(
        steamid
      );


      console.log(
        `USABLE: ${result.personaname} | ` +
        `${result.gameCount} games | ` +
        `${result.neverPlayed} unplayed | ` +
        `${result.totalHours} hours`
      );


      return {

        steamid,

        personaname:
          result.personaname,

        status:
          "completed",

        gameCount:
          result.gameCount,

        neverPlayed:
          result.neverPlayed,

        totalHours:
          result.totalHours
      };
    }

if (
  result.gamesVisible &&
  result.playtimeAvailable === false
) {

  await markPlaytimeUnavailable(
    steamid
  );


  console.log(
    `PLAYTIME HIDDEN/UNAVAILABLE: ` +
    `${result.personaname} | ` +
    `${result.gameCount} visible games`
  );


  return {

    steamid,

    personaname:
      result.personaname,

    status:
      "playtime_unavailable",

    gameCount:
      result.gameCount
  };
}


    /*
     * Profile exists, but game details
     * aren't public.
     */
    await markGameDetailsPrivate(
      steamid
    );


    console.log(
      `PRIVATE GAME DETAILS: ` +
      `${result.personaname} (${steamid})`
    );


    return {

      steamid,

      personaname:
        result.personaname,

      status:
        "game_details_private",

      gamesVisible:
        false
    };


  } catch (error) {


    /*
     * SteamID wasn't found.
     */
    if (
      error.code ===
      "PROFILE_NOT_FOUND"
    ) {

      await markNotFound(
        steamid
      );


      console.log(
        `NOT FOUND: ${steamid}`
      );


      return {

        steamid,

        status:
          "not_found"
      };
    }


    /*
     * Network error, Steam error, database
     * error, etc.
     *
     * Try again later.
     */
    console.error(
      `Profile collection failed for ` +
      `${steamid}:`,
      error.message
    );


    const status =
      await retryOrFail(
        steamid,
        error.message
      );


    return {

      steamid,

      status,

      error:
        error.message
    };
  }
}

export async function processProfileQueue(
  options = {}
) {

  await resetStaleProcessing();


  const requestedLimit =
    Number(
      options.limit ??
      config.profileQueueBatchSize
    );


  const limit =
    Math.min(
      Math.max(
        requestedLimit,
        1
      ),
      30000
    );


  const requestedConcurrency =
    Number(
      options.concurrency ??
      config.profileQueueConcurrency
    );


  const concurrency =
    Math.min(
      Math.max(
        requestedConcurrency,
        1
      ),
      10
    );


  console.log(
    `Processing profile queue: ` +
    `limit=${limit}, ` +
    `concurrency=${concurrency}`
  );


  /*
   * Each token represents permission
   * to claim one profile.
   *
   * JavaScript's synchronous decrement
   * prevents workers from exceeding limit.
   */
  let remaining =
    limit;


  const results = [];


  async function worker(
    workerNumber
  ) {

    while (true) {


      /*
       * Reserve one of our batch slots.
       */
      if (
        remaining <= 0
      ) {

        return;
      }


      remaining--;


      const item =
        await claimNextProfile();


      /*
       * Queue currently has no eligible
       * profiles.
       */
      if (!item) {

        return;
      }


      console.log(
        `Profile worker ${workerNumber}: ` +
        item.steamid
      );


      const result =
        await processProfile(
          item
        );


      results.push(
        result
      );


      await sleep(
        config.profileQueueDelayMs
      );
    }
  }


  const workers =
    Array.from(
      {
        length:
          concurrency
      },

      (_, index) =>
        worker(
          index + 1
        )
    );


  await Promise.all(
    workers
  );


  const summary = {

    requested:
      limit,

    processed:
      results.length,

    completed:
      results.filter(
        item =>
          item.status ===
          "completed"
      ).length,

    private:
      results.filter(
        item =>
          item.status ===
          "game_details_private"
      ).length,

    playtimeUnavailable:
      results.filter(
        item =>
          item.status ===
          "playtime_unavailable"
      ).length,

    notFound:
      results.filter(
        item =>
          item.status ===
          "not_found"
      ).length,

    retrying:
      results.filter(
        item =>
          item.status ===
          "retry"
      ).length,

    failed:
      results.filter(
        item =>
          item.status ===
          "failed"
      ).length
  };

  let dashboardStatistics = null;

  if (results.length > 0) {
    try {
      dashboardStatistics = await refreshDashboardStatistics();
      console.log("Dashboard statistics refreshed");
    } catch (error) {
      console.error("Could not refresh dashboard stats",error);
    }
  }

  let profileSpotlights = null;

  try {
    profileSpotlights = await refreshProfileSpotlights();
  } catch (error) {
    console.error("Could not refresh profile spotlights", error);
  }


  return {
    summary,
    dashboardStatistics,
    results
  };
}

export async function getProfileQueueStatus() {

  const queueResult =
    await pool.query(
      `
        SELECT

          COUNT(*)::integer
            AS total,

          COUNT(*) FILTER (
            WHERE status =
              'pending'
          )::integer
            AS pending,

          COUNT(*) FILTER (
            WHERE status =
              'processing'
          )::integer
            AS processing,

          COUNT(*) FILTER (
            WHERE status =
              'completed'
          )::integer
            AS completed,

          COUNT(*) FILTER (
            WHERE status =
              'game_details_private'
          )::integer
            AS game_details_private,

          COUNT(*) FILTER (
           WHERE status =
            'playtime_unavailable'
          )::integer
            AS playtime_unavailable,

          COUNT(*) FILTER (
            WHERE status =
              'not_found'
          )::integer
            AS not_found,

          COUNT(*) FILTER (
            WHERE status =
              'failed'
          )::integer
            AS failed

        FROM steam_profile_queue
      `
    );


  const gameResult =
    await pool.query(
      `
        SELECT

          COUNT(*)::integer
            AS game_records,

          COUNT(
            DISTINCT steamid
          )::integer
            AS profiles_with_games,

          COALESCE(
            SUM(
              playtime_forever_minutes
            ),
            0
          ) AS total_playtime_minutes,

          COUNT(*) FILTER (
            WHERE
              playtime_forever_minutes = 0
          )::integer
            AS unplayed_game_records

        FROM steam_profile_games
      `
    );


  const queue =
    queueResult.rows[0];


  const games =
    gameResult.rows[0];


  /*
   * Use only profiles where game-details
   * visibility has actually been determined.
   *
   * not_found and failed aren't part of
   * the public-vs-private calculation.
   */
  const analyzed =
    queue.completed +
    queue.game_details_private;


  const publicPercentage =
    analyzed > 0
      ? Number(
          (
            queue.completed /
            analyzed *
            100
          ).toFixed(1)
        )
      : 0;


  return {

    queue,

    analysis: {

      analyzedProfiles:
        analyzed,

      publicGameLibraries:
        queue.completed,

      privateGameLibraries:
        queue
          .game_details_private,

      publicLibraryPercentage:
        publicPercentage,

      storedGameRecords:
        games.game_records,

      profilesWithStoredGames:
        games.profiles_with_games,

      unplayedGameRecords:
        games.unplayed_game_records,

      totalPlaytimeHours:
        Number(
          (
            Number(
              games
                .total_playtime_minutes
            ) /
            60
          ).toFixed(1)
        )
    }
  };
}
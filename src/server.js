import express from "express";
import cron from "node-cron";
import cors from "cors";

import { config } from "./config.js";
import { pool, waitForDatabase } from "./db.js";
import { collectSnapshot } from "./collector.js";
import profileRoutes from "./profileRoutes.js";
import friendDiscoveryRoutes from "./friendDiscoveryRoutes.js";
import profileQueueRoutes from "./profileQueueRoutes.js";
import adminRoutes from "./adminRoutes.js";
import { requireAdmin } from "./adminAuth.js";

const app = express();


app.use(
  cors({

    origin:
      config.frontendUrl,

    credentials: true
  })
);

app.use(express.json());

app.use("/api/admin", adminRoutes);
app.use("/api/profile-queue", requireAdmin, profileQueueRoutes);
app.use("/api/discovery", requireAdmin, friendDiscoveryRoutes);
app.use("/api/profiles", profileRoutes);


/*
 * Health check
 */
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      database: "connected",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      database: "disconnected"
    });
  }
});


/*
 * Latest snapshot
 */
app.get("/api/snapshots/latest", async (req, res) => {
  try {
    const snapshotResult =
        await pool.query(
          `
            SELECT
              id,
              sampled_at,
              number_of_games,
              total_concurrent_players

            FROM snapshots

            ORDER BY sampled_at DESC

            LIMIT 1
          `
        );


      if (
        snapshotResult.rows.length === 0
      ) {

        return res.status(404).json({
          message:
            "No snapshots have been collected yet."
        });
      }


      const snapshot =
        snapshotResult.rows[0];


      const gameResult =
        await pool.query(
          `
            SELECT
              pc.ranking,
              pc.appid,
              g.name,
              pc.current_players,
              pc.peak_24h

            FROM player_counts pc

            JOIN games g
              ON g.appid = pc.appid

            WHERE pc.snapshot_id = $1

            ORDER BY pc.ranking
          `,
          [snapshot.id]
        );


      res.json({
        snapshot,
        games: gameResult.rows
      });
   /*  const [snapshots] = await pool.query(
      `
        SELECT *
        FROM snapshots
        ORDER BY sampled_at DESC
        LIMIT 1
      `
    );

    if (snapshots.length === 0) {
      return res.status(404).json({
        message: "No snapshots have been collected yet."
      });
    }

    const snapshot = snapshots[0];

    const [games] = await pool.query(
      `
        SELECT
          pc.ranking,
          pc.appid,
          g.name,
          pc.current_players,
          pc.peak_24h
        FROM player_counts pc

        JOIN games g
          ON g.appid = pc.appid

        WHERE pc.snapshot_id = ?

        ORDER BY pc.ranking
      `,
      [snapshot.id]
    );

    res.json({
      snapshot,
      games
    }); */
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not retrieve snapshot."
    });
  }
});

app.get(
  "/api/snapshots/latest-summary",

  async (req, res) => {

    try {

      const result =
        await pool.query(
          `
            SELECT

              id,
              sampled_at,
              number_of_games,
              total_concurrent_players

            FROM snapshots

            ORDER BY sampled_at DESC

            LIMIT 2
          `
        );


      if (
        result.rows.length === 0
      ) {

        return res
          .status(404)
          .json({
            error:
              "No Steam snapshots have been collected yet."
          });
      }


      const current = result.rows[0];


      const previous = result.rows[1] ?? null;


      const currentPlayers = Number(current.total_concurrent_players);


      const previousPlayers = previous ? Number(previous.total_concurrent_players) : null;


      const playerDifference = previousPlayers !== null ? currentPlayers - previousPlayers : null;


      const percentDifference =
        previousPlayers &&
        previousPlayers !== 0
          ? (
              playerDifference /
              previousPlayers
            ) * 100
          : null;


      res.json({

        current: {

          snapshotId:
            Number(current.id),

          sampledAt:
            current.sampled_at,

          numberOfGames:
            Number(
              current.number_of_games
            ),

          totalConcurrentPlayers:
            currentPlayers
        },


        previous:
          previous
            ? {

                snapshotId:
                  Number(
                    previous.id
                  ),

                sampledAt:
                  previous.sampled_at,

                totalConcurrentPlayers:
                  previousPlayers

              }
            : null,


        change: {

          players:
            playerDifference,

          percentage:
            percentDifference !== null
              ? Number(
                  percentDifference
                    .toFixed(2)
                )
              : null
        }
      });


    } catch (error) {

      console.error(
        "Latest snapshot summary failed:",
        error
      );


      res.status(500).json({

        error:
          "Could not retrieve latest Steam snapshot.",

        message:
          error.message
      });
    }
  }
);

 app.get(
  "/api/dashboard-summary",

  async (req, res) => {

    const client = await pool.connect();

    try {

      await client.query("BEGIN");
      await client.query(
        `
          SET LOCAL
          statement_timeout = '15000ms'
        `);

      const result =
        await pool.query(
          `
            SELECT

    profile_stats.profiles_analyzed,
    profile_stats.avg_lib_size,

    game_stats.owned_games,

    game_stats.unplayed_games

FROM

(
    SELECT
        COUNT(*)::bigint
            AS profiles_analyzed,
        AVG(reported_game_count)::numeric AS avg_lib_size

    FROM steam_profiles

    WHERE
        games_visible = TRUE
        AND playtime_available = TRUE
) profile_stats

CROSS JOIN

(
    SELECT

        COUNT(*)::bigint
            AS owned_games,

        COUNT(*) FILTER (
            WHERE
                g.playtime_forever_minutes = 0
        )::bigint
            AS unplayed_games

    FROM steam_profile_games g

    INNER JOIN steam_profiles p
        ON p.steamid = g.steamid

    WHERE
        p.games_visible = TRUE
        AND p.playtime_available = TRUE

) game_stats;
          `
        );

        await client.query("COMMIT");


      const row =
        result.rows[0];


      const profilesAnalyzed =
        Number(
          row.profiles_analyzed
        );


      const ownedGames =
        Number(
          row.owned_games
        );


      const unplayedGames =
        Number(
          row.unplayed_games
        );


      const unplayedPercentage =
        ownedGames > 0
          ? Number(
              (
                unplayedGames /
                ownedGames *
                100
              ).toFixed(1)
            )
          : 0;

      const avgLibrarySize = Number(row.avg_lib_size).toFixed(1);

        /* ownedGames > 0
          ? Number(
              (
                ownedGames /
                profilesAnalyzed *
                100
              ).toFixed(1)
            )
          : 0; */


      res.json({

        profilesAnalyzed,

        ownedGames,

        unplayedGames,

        unplayedPercentage,

        avgLibrarySize,

        generatedAt:
          new Date().toISOString()
      });


    } catch (error) {

      try {
        await client.query("ROLLBACK");
      } catch {

      }

      console.error(
        "Dashboard summary failed:",
        error
      );

      if (error.code === "57014") {
        return res.status(503).json({
          error: "dashboard statistics query timed out"
        });
      }


      res.status(500).json({

        error:
          "Could not retrieve dashboard summary.",

        message:
          error.message
      });
    } finally {
      client.release();
    }
  }
);


/*
 * Top-100 aggregate history.
 *
 * This will eventually feed your React line chart.
 *
 * Example:
 *
 * /api/history?days=7
 */
app.get("/api/history", async (req, res) => {
  try {
    const days = Math.min(
      Math.max(Number(req.query.days) || 7, 1),
      365
    );

    const result = await pool.query(
          `
            SELECT
              id,
              sampled_at,
              number_of_games,
              total_concurrent_players

            FROM snapshots

            WHERE sampled_at >=
              NOW() -
              ($1 * INTERVAL '1 day')

            ORDER BY sampled_at
          `,
          [days]
        );


      res.json(result.rows);
/*     const [rows] = await pool.query(
      `
        SELECT
          id,
          sampled_at,
          number_of_games,
          total_concurrent_players
        FROM snapshots

        WHERE sampled_at >=
          UTC_TIMESTAMP() - INTERVAL ? DAY

        ORDER BY sampled_at
      `,
      [days]
    );

    res.json(rows); */
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not retrieve history."
    });
  }
});

/*
  daily top 100 aggregate history
  one snapshot per day, closest to the requested time

  /ap/history/daily?days=30&time=20:00
*/

app.get("/api/history/daily", async (req, res) => {


  const time = String(req.query.time || "20:00");

  const daysParam = String(req.query.days || "30").toLowerCase();

  //eastern time
  const timezone = "America/New_York";

  const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time);

  if (!validTime) {

    return res
      .status(400)
      .json({
        error:
        "Invalid time. Use HH:MM format."
      });
  }

  const allDays = daysParam === "all";

  let days = 30;

  if (!allDays) {

      days =
        Number(daysParam);


      if (
        !Number.isInteger(days) ||
        days < 1 ||
        days > 730
      ) {

        return res
          .status(400)
          .json({
            error:
              "days must be between 1 and 730, or 'all'."
          });
      }
  }

  try {
    const result = await pool.query(
      `
        WITH bounds as (
          select
            case
              /*
                   * For "all", start on the
                   * first date in the dataset.
                   */
                  WHEN $1::boolean THEN

                    COALESCE(

                      MIN(
                        timezone(
                          $3,
                          sampled_at
                        )::date
                      ),

                      timezone(
                        $3,
                        NOW()
                      )::date
                    )


                  /*
                   * Otherwise go back N days.
                   */
                  ELSE

                    timezone(
                      $3,
                      NOW()
                    )::date
                    -
                    ($4::integer - 1)

                END
                  AS start_date,


                timezone(
                  $3,
                  NOW()
                )::date
                  AS end_date


              FROM snapshots
            ),


            calendar_days AS (

              SELECT

                generated_day::date
                  AS local_date


              FROM bounds b


              CROSS JOIN LATERAL

                generate_series(

                  b.start_date::timestamp,

                  b.end_date::timestamp,

                  INTERVAL '1 day'

                ) AS generated_day
            )


            SELECT

              TO_CHAR(
                d.local_date,
                'YYYY-MM-DD'
              )
                AS local_date,

              s.sampled_at,

              s.total_concurrent_players


            FROM calendar_days d


            /*
             * Convert the user's chosen
             * Eastern clock time into the
             * correct UTC instant for each
             * individual date.
             *
             * This automatically handles
             * daylight saving time.
             */
            CROSS JOIN LATERAL (

              SELECT

                timezone(

                  $3,

                  d.local_date +
                  $2::time

                )
                  AS target_timestamp

            ) target


            /*
             * Find the actual stored snapshot
             * nearest that requested time.
             *
             * Because data is sampled every
             * 15 minutes, +/- 10 minutes gives
             * enough tolerance for small drift.
             */
            JOIN LATERAL (

              SELECT

                sn.sampled_at,

                sn.total_concurrent_players


              FROM snapshots sn


              WHERE

                sn.sampled_at >=
                  target.target_timestamp
                  -
                  INTERVAL '10 minutes'


                AND


                sn.sampled_at <=
                  target.target_timestamp
                  +
                  INTERVAL '10 minutes'


              ORDER BY

                ABS(

                  EXTRACT(

                    EPOCH FROM (

                      sn.sampled_at
                      -
                      target.target_timestamp

                    )
                  )
                )


              LIMIT 1

            ) s
              ON TRUE


            ORDER BY
              d.local_date
          `,
          [
            allDays,
            time,
            timezone,
            days
          ]
        );


      res.json({

        time,

        timezone,

        range:
          allDays
            ? "all"
            : days,

        pointCount:
          result.rows.length,

        points:
          result.rows.map(
            row => ({

              date:
                row.local_date,

              sampledAt:
                row.sampled_at,

              totalConcurrentPlayers:
                Number(
                  row.total_concurrent_players
                )
            })
          )
      });

  } catch (error) {
    console.error("daily history query failed", error);
  

  res.status(500).json({
    error: "Could not retrieve daily steam history",
    message: error.message
  });
  }

});


/*
 * History for one game.
 *
 * Example:
 *
 * /api/games/730/history?days=30
 */
app.get("/api/games/:appid/history", async (req, res) => {
  try {
    const appid = Number(req.params.appid);

    const days = Math.min(
      Math.max(Number(req.query.days) || 30, 1),
      365
    );

    const result = await pool.query(
          `
            SELECT
              s.sampled_at,
              pc.ranking,
              pc.current_players,
              pc.peak_24h

            FROM player_counts pc

            JOIN snapshots s
              ON s.id = pc.snapshot_id

            WHERE pc.appid = $1

              AND s.sampled_at >=
                NOW() -
                ($2 * INTERVAL '1 day')

            ORDER BY s.sampled_at
          `,
          [
            appid,
            days
          ]
        );

      res.json(result.rows);
    /* const [rows] = await pool.query(
      `
        SELECT
          s.sampled_at,
          pc.ranking,
          pc.current_players,
          pc.peak_24h

        FROM player_counts pc

        JOIN snapshots s
          ON s.id = pc.snapshot_id

        WHERE pc.appid = ?
          AND s.sampled_at >=
              UTC_TIMESTAMP() - INTERVAL ? DAY

        ORDER BY s.sampled_at
      `,
      [appid, days]
    );

    res.json(rows); */
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not retrieve game history."
    });
  }
});

app.get("/api/crawl/:runID", async (req, res) => {
  try {
    const runID = Number(req.params.runID);

    const result = await pool.query(
          `
            SELECT
            depth,
            status,
            COUNT(*)

            FROM friend_crawl_queue

            WHERE crawl_run_id = $1

            GROUP BY
            depth,
            status

            ORDER BY
            depth,
            status;
          `,
          [
            runID
          ]
        );

      res.json(result.rows);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not retrieve data."
    });
  }
});

app.get("/api/crawl", async (req, res) => {
  try {

    const result = await pool.query(
          `
            SELECT *

            FROM friend_crawl_queue

            ORDER BY
            depth,
            status;
          `
        );

      res.json(result.rows);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not retrieve data."
    });
  }
});

app.get("/api/discoveries", async (req, res) => {
  try {

    const result = await pool.query(
          `
            SELECT *

            FROM steam_profile_discoveries

            WHERE discovery_source = 'friend'

            ORDER BY
            graph_depth,
            discovered_at;
          `
        );

      res.json(result.rows);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not retrieve data."
    });
  }
});

//status, COUNT(*)

app.get("/api/profile_queue", async (req, res) => {
  try {

    const result = await pool.query(
          `
            SELECT status, COUNT(*)

            FROM steam_profile_queue
            group by status
            ;
          `
        );

      res.json(result.rows);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not retrieve data."
    });
  }
});

app.get("/api/profiles", async (req, res) => {
  try {

    const result = await pool.query(
          `
            SELECT *
            FROM steam_profiles
            order by first_collected_at
            limit 1000
            ;
          `
        );

      res.json(result.rows);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not retrieve data."
    });
  }
});

/*             UPDATE steam_profile_queue

        SET
          status = 'pending',
          attempts = 0,
          next_attempt_at = NOW(),

          error_message =
            'Recovered stale processing job.'

        WHERE status = 'failed' */

app.get("/api/reset_failed", async (req, res) => {
  try {

    const result = await pool.query(
          `
            UPDATE steam_profile_queue

        SET
          status = 'pending',
          attempts = 0,
          next_attempt_at = NOW(),

          error_message =
            'Recovered stale processing job.'

        WHERE status = 'failed'
            ;
          `
        );

      res.json(result.rows.length);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not retrieve data."
    });
  }
});

async function start() {
  await waitForDatabase();

  /*
   * Start the scheduled collection.
   */
 /*  cron.schedule(config.collectCron, async () => {
    await collectSnapshot();
  });

  console.log(
    `Steam collection schedule: ${config.collectCron}`
  );
  */

  /*
   * Very useful while developing because otherwise you'd
   * have to wait until the next :00, :15, :30, or :45.
   */

 /*  if (config.runOnStartup) {
    collectSnapshot();
  } */
  
  

  app.listen(config.port, () => {
    console.log(
      `Steam Tracker API listening on port ${config.port}`
    );
  });
}

start().catch((error) => {
  console.error("Application failed to start:", error);

  process.exit(1);
});
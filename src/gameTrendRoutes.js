import express from "express";

import {
  pool
} from "./db.js";


const router =
  express.Router();


const TIMEZONE =
  "America/New_York";


function validAppId(
  appid
) {

  return /^\d+$/.test(
    String(appid)
  );
}


function validTime(
  value
) {

  const match =
    /^(\d{2}):(\d{2})$/.exec(
      String(value)
    );


  if (!match) {
    return false;
  }


  const hours =
    Number(match[1]);

  const minutes =
    Number(match[2]);


  return (
    hours >= 0 &&
    hours <= 23 &&
    minutes >= 0 &&
    minutes <= 59
  );
}


function dateKey(
  value
) {

  if (!value) {
    return null;
  }


  if (
    typeof value ===
    "string"
  ) {

    return value.slice(
      0,
      10
    );
  }


  return new Date(value)
    .toISOString()
    .slice(
      0,
      10
    );
}


/*
 * IMPORTANT:
 * Keep /search before /:appid.
 */
router.get(
  "/search",

  async (
    req,
    res
  ) => {

    try {

      const q =
        String(
          req.query.q || ""
        )
          .trim()
          .slice(
            0,
            100
          );


      if (!q) {

        return res.json({
          games: []
        });
      }


      const result =
        await pool.query(
          `
            SELECT

              appid,
              name,
              first_seen_at,
              last_seen_at

            FROM games

            WHERE

              appid::text = $1

              OR

              POSITION(
                LOWER($1)
                IN
                LOWER(
                  COALESCE(
                    name,
                    ''
                  )
                )
              ) > 0


            ORDER BY

              CASE

                WHEN appid::text = $1
                  THEN 0

                WHEN LOWER(name) =
                     LOWER($1)
                  THEN 1

                WHEN LEFT(
                       LOWER(name),
                       LENGTH($1)
                     ) =
                     LOWER($1)
                  THEN 2

                ELSE 3

              END,

              last_seen_at DESC


            LIMIT 12
          `,
          [
            q
          ]
        );


      res.json({

        games:
          result.rows.map(
            row => ({

              appid:
                Number(
                  row.appid
                ),

              name:
                row.name,

              firstSeenAt:
                row.first_seen_at,

              lastSeenAt:
                row.last_seen_at
            })
          )
      });


    } catch (error) {

      console.error(
        "Game search failed:",
        error
      );


      res
        .status(500)
        .json({
          error:
            "Could not search tracked games."
        });
    }
  }
);


router.get(
  "/:appid",

  async (
    req,
    res
  ) => {

    const {
      appid
    } =
      req.params;


    if (
      !validAppId(
        appid
      )
    ) {

      return res
        .status(400)
        .json({
          error:
            "Invalid Steam AppID."
        });
    }


    const sampling =
      req.query.sampling ===
      "all"
        ? "all"
        : "daily";


    const time =
      String(
        req.query.time ||
        "20:00"
      );


    if (
      !validTime(
        time
      )
    ) {

      return res
        .status(400)
        .json({
          error:
            "time must use HH:MM format."
        });
    }


    const daysParameter =
      String(
        req.query.days ||
        "30"
      );


    let days =
      null;


    if (
      daysParameter !==
      "all"
    ) {

      days =
        Number(
          daysParameter
        );


      if (
        !Number.isInteger(days) ||
        days < 1 ||
        days > 730
      ) {

        return res
          .status(400)
          .json({
            error:
              "days must be 1-730 or all."
          });
      }
    }


    try {

      const gameResult =
        await pool.query(
          `
            SELECT

              appid,
              name,
              first_seen_at,
              last_seen_at

            FROM games

            WHERE appid = $1
          `,
          [
            appid
          ]
        );


      if (
        gameResult.rows.length ===
        0
      ) {

        return res
          .status(404)
          .json({
            error:
              "This game has not been tracked."
          });
      }


      let historyResult;


      /*
       * Every collector snapshot.
       *
       * LEFT JOIN is intentional:
       * null = game was not in the Top 100.
       */
      if (
        sampling ===
        "all"
      ) {

        historyResult =
          await pool.query(
            `
              WITH bounds AS (

                SELECT

                  CASE

                    WHEN $2::integer
                         IS NULL

                    THEN first_seen_at

                    ELSE
                      NOW()
                      -
                      (
                        $2::integer
                        *
                        INTERVAL '1 day'
                      )

                  END
                    AS start_time

                FROM games

                WHERE appid = $1
              )


              SELECT

                s.sampled_at
                  AS chart_timestamp,

                s.sampled_at,

                NULL::date
                  AS local_date,

                pc.current_players,

                pc.ranking,

                pc.peak_24h


              FROM snapshots s

              CROSS JOIN bounds b


              LEFT JOIN player_counts pc

                ON pc.snapshot_id =
                   s.id

                AND pc.appid =
                    $1


              WHERE
                s.sampled_at >=
                b.start_time


              ORDER BY
                s.sampled_at ASC
            `,
            [
              appid,
              days
            ]
          );

      } else {

        /*
         * One point per Eastern-calendar day,
         * nearest the chosen time.
         */
        historyResult =
          await pool.query(
            `
              WITH bounds AS (

                SELECT

                  CASE

                    WHEN $2::integer
                         IS NULL

                    THEN
                      (
                        first_seen_at
                        AT TIME ZONE $4
                      )::date

                    ELSE

                      (
                        NOW()
                        AT TIME ZONE $4
                      )::date

                      -

                      (
                        $2::integer - 1
                      )

                  END
                    AS start_date,


                  (
                    NOW()
                    AT TIME ZONE $4
                  )::date
                    AS end_date


                FROM games

                WHERE appid = $1
              ),


              days AS (

                SELECT

                  generate_series(
                    start_date,
                    end_date,
                    INTERVAL '1 day'
                  )::date
                    AS local_date

                FROM bounds
              ),


              targets AS (

                SELECT

                  local_date,

                  (
                    (
                      local_date
                      +
                      $3::time
                    )
                    AT TIME ZONE $4
                  )
                    AS target_timestamp

                FROM days
              )


              SELECT

                t.target_timestamp
                  AS chart_timestamp,

                t.local_date,

                s.sampled_at,

                pc.current_players,

                pc.ranking,

                pc.peak_24h


              FROM targets t


              LEFT JOIN LATERAL (

                SELECT

                  id,
                  sampled_at

                FROM snapshots

                WHERE

                  sampled_at >=
                    t.target_timestamp
                    -
                    INTERVAL '10 minutes'

                  AND

                  sampled_at <=
                    t.target_timestamp
                    +
                    INTERVAL '10 minutes'


                ORDER BY

                  ABS(
                    EXTRACT(
                      EPOCH FROM
                      (
                        sampled_at
                        -
                        t.target_timestamp
                      )
                    )
                  )

                LIMIT 1

              ) s
                ON TRUE


              LEFT JOIN player_counts pc

                ON pc.snapshot_id =
                   s.id

                AND pc.appid =
                    $1


              ORDER BY
                t.local_date ASC
            `,
            [
              appid,
              days,
              time,
              TIMEZONE
            ]
          );
      }


      /*
       * Latest GLOBAL snapshot.
       *
       * If pc is null here, the game
       * currently isn't in our Top 100.
       */
      const latestResult =
        await pool.query(
          `
            SELECT

              s.sampled_at,

              pc.current_players,

              pc.ranking,

              pc.peak_24h

            FROM snapshots s


            LEFT JOIN player_counts pc

              ON pc.snapshot_id =
                 s.id

              AND pc.appid =
                  $1


            ORDER BY
              s.sampled_at DESC

            LIMIT 1
          `,
          [
            appid
          ]
        );


      /*
       * Last time we actually saw it
       * inside the Top 100.
       */
      const lastTrackedResult =
        await pool.query(
          `
            SELECT

              s.sampled_at,

              pc.current_players,

              pc.ranking,

              pc.peak_24h

            FROM player_counts pc

            INNER JOIN snapshots s

              ON s.id =
                 pc.snapshot_id

            WHERE
              pc.appid = $1

            ORDER BY
              s.sampled_at DESC

            LIMIT 1
          `,
          [
            appid
          ]
        );


      const points =
        historyResult.rows.map(
          row => {

            const timestamp =
              new Date(
                row.chart_timestamp
              );


            return {

              timestamp:
                timestamp.getTime(),

              sampledAt:
                row.sampled_at
                  ? new Date(
                      row.sampled_at
                    ).toISOString()
                  : null,

              date:
                dateKey(
                  row.local_date
                ),

              currentPlayers:
                row.current_players ===
                null
                  ? null
                  : Number(
                      row.current_players
                    ),

              ranking:
                row.ranking ===
                null
                  ? null
                  : Number(
                      row.ranking
                    ),

              peak24h:
                row.peak_24h ===
                null
                  ? null
                  : Number(
                      row.peak_24h
                    )
            };
          }
        );


      const trackedPoints =
        points.filter(
          point =>
            point.currentPlayers !==
            null
        );


      const firstTracked =
        trackedPoints[0] ||
        null;


      const lastTrackedInRange =
        trackedPoints[
          trackedPoints.length - 1
        ] ||
        null;


      const rangePeakPlayers =
        trackedPoints.length > 0
          ? Math.max(
              ...trackedPoints.map(
                point =>
                  point.currentPlayers
              )
            )
          : null;


      let rangeChangePlayers =
        null;


      let rangeChangePercentage =
        null;


      if (
        firstTracked &&
        lastTrackedInRange
      ) {

        rangeChangePlayers =
          lastTrackedInRange
            .currentPlayers
          -
          firstTracked
            .currentPlayers;


        if (
          firstTracked
            .currentPlayers > 0
        ) {

          rangeChangePercentage =
            Number(
              (
                rangeChangePlayers
                /
                firstTracked
                  .currentPlayers
                *
                100
              ).toFixed(2)
            );
        }
      }


      const latest =
        latestResult.rows[0] ||
        null;


      const lastTracked =
        lastTrackedResult
          .rows[0] ||
        null;


      const game =
        gameResult.rows[0];


      res.json({

        game: {

          appid:
            Number(
              game.appid
            ),

          name:
            game.name,

          firstSeenAt:
            game.first_seen_at,

          lastSeenAt:
            game.last_seen_at
        },


        sampling,

        days:
          daysParameter,

        time:
          sampling ===
          "daily"
            ? time
            : null,

        timezone:
          TIMEZONE,


        summary: {

          currentlyTracked:
            latest
              ?.current_players !==
            null
            &&
            latest
              ?.current_players !==
            undefined,

          latestSnapshotAt:
            latest
              ?.sampled_at ||
            null,

          currentPlayers:
            latest
              ?.current_players ===
            null ||
            latest
              ?.current_players ===
            undefined
              ? null
              : Number(
                  latest
                    .current_players
                ),

          currentRank:
            latest
              ?.ranking ===
            null ||
            latest
              ?.ranking ===
            undefined
              ? null
              : Number(
                  latest.ranking
                ),

          latestPeak24h:
            latest
              ?.peak_24h ===
            null ||
            latest
              ?.peak_24h ===
            undefined
              ? null
              : Number(
                  latest.peak_24h
                ),

          lastTrackedAt:
            lastTracked
              ?.sampled_at ||
            null,

          rangePeakPlayers,

          rangeChangePlayers,

          rangeChangePercentage,

          trackedPointCount:
            trackedPoints.length,

          pointCount:
            points.length
        },


        points
      });


    } catch (error) {

      console.error(
        "Game trend query failed:",
        error
      );


      res
        .status(500)
        .json({

          error:
            "Could not retrieve game trend data.",

          message:
            error.message
        });
    }
  }
);


export default router;
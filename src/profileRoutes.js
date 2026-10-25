import express from "express";
import { pool } from "./db.js";
import { collectProfile } from "./profileCollector.js";
import { getFriendList } from "./steam.js";
import { backfillPlaytimeAvailability } from "./profileMaintenance.js";
import { requireAdmin, requireTrustedOrigin } from "./adminAuth.js";
import { refreshDashboardStatistics } from "./dashboardStatistics.js";
import { refreshProfileSpotlights } from "./profileStatistics.js";

const router = express.Router();

function validSteamId(steamid) {
     return /^\d{1,20}$/.test(steamid);
}

function minutesToHours(
  minutes,
  decimals = 1
) {

  if (
    minutes === null ||
    minutes === undefined
  ) {

    return null;
  }


  return Number(
    (
      Number(minutes) /
      60
    ).toFixed(decimals)
  );
}

router.post("/:steamid/collect", requireAdmin, requireTrustedOrigin, async (req, res) => {

    const steamid =
      req.params.steamid;


    if (!validSteamId(steamid)) {

      return res.status(400).json({
        error:
          "Invalid SteamID64."
      });
    }

    try {

      const result =
        await collectProfile(
          steamid
        );

        /*
          refresh the caches dashboard row. Need to change this when updating all 35k
          profiles or use a different endpoint
        */

          let dashboardStatistics = null;
          let profileSpotlights = null;
          let dashboardStatisticsUpdated = false;

          try {
            //dashboardStatistics  = await refreshDashboardStatistics();
            //dashboardStatisticsUpdated = true;
            [
              dashboardStatistics,
              profileSpotlights
            ] = await Promise.all([
              refreshDashboardStatistics(),
              refreshProfileSpotlights()
            ]);

            dashboardStatisticsUpdated = true;


          } catch (error) {
            console.error("profile collected successfully but dashboard stats not refreshed");
          }


      res.json({
        success: true,
        steamid,
        result,
        dashboardStatisticsUpdated,
        dashboardStatistics
      });

    } catch (error) {

      console.error(error);

      if (
        error.code ===
        "PROFILE_NOT_FOUND"
      ) {

        return res
          .status(404)
          .json({
            error:
              error.message
          });
      }

      res.status(500).json({
        error:
          "Profile collection failed."
      });
    }
  }
);

router.get("/median-playtime", async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
    p.steamid,

    p.personaname,

    COUNT(*) AS games_owned,

    COUNT(*) FILTER (
        WHERE
          g.playtime_forever_minutes = 0
    ) AS never_played,

    ROUND(
        COUNT(*) FILTER (
            WHERE
              g.playtime_forever_minutes = 0
        )::numeric
        /
        COUNT(*)::numeric
        * 100,
        1
    )
        AS never_played_percentage,

    ROUND(
        (
          PERCENTILE_CONT(0.5)
          WITHIN GROUP (
              ORDER BY
                g.playtime_forever_minutes
          )
          /
          60.0
        )::numeric,
        2
    )
        AS median_hours_per_game,

        ROUND(
        (
          AVG(
              g.playtime_forever_minutes
          )
          /
          60.0
        )::numeric,
        2
    ) AS average_hours_per_game

FROM steam_profiles p

JOIN steam_profile_games g
    ON g.steamid =
       p.steamid

WHERE
    p.games_visible = TRUE

    AND
    p.playtime_available = TRUE

GROUP BY
    p.steamid,
    p.personaname

    ORDER BY
    games_owned DESC;
      `
    );
    
    res.json({success: true, ...result});
  } catch (error) {
    console.error(error);
     res.status(500).json({error: "Could not retrieve median playtime."});
  }
  }
);

router.get("/library-cohorts", async (req, res) => {
  try {
    const result = await pool.query(
        `
          WITH profile_stats AS (

            /*
             * First calculate statistics for
             * every individual usable profile.
             */
            SELECT

              p.steamid,

              COUNT(g.appid)::integer
                AS games_owned,


              COUNT(*) FILTER (
                WHERE
                  g.playtime_forever_minutes = 0
              )::integer
                AS unplayed_games,


              PERCENTILE_CONT(0.5)
              WITHIN GROUP (
                ORDER BY
                  g.playtime_forever_minutes
              )
                AS median_playtime_minutes


            FROM steam_profiles p


            JOIN steam_profile_games g
              ON g.steamid = p.steamid


            WHERE
              p.games_visible = TRUE

              AND
              p.playtime_available = TRUE


            GROUP BY
              p.steamid
          ),


          cohort_profiles AS (

            /*
             * Assign each profile to exactly
             * one library-size cohort.
             */
            SELECT

              steamid,

              games_owned,

              unplayed_games,

              median_playtime_minutes,


              CASE

                WHEN games_owned
                  BETWEEN 1 AND 50
                  THEN '1-50'

                WHEN games_owned
                  BETWEEN 51 AND 100
                  THEN '51-100'

                WHEN games_owned
                  BETWEEN 101 AND 250
                  THEN '101-250'

                WHEN games_owned
                  BETWEEN 251 AND 500
                  THEN '251-500'

                WHEN games_owned
                  BETWEEN 501 AND 1000
                  THEN '501-1000'

                WHEN games_owned >= 1001
                  THEN '1000+'

              END
                AS cohort,


              CASE

                WHEN games_owned
                  BETWEEN 1 AND 50
                  THEN 1

                WHEN games_owned
                  BETWEEN 51 AND 100
                  THEN 2

                WHEN games_owned
                  BETWEEN 101 AND 250
                  THEN 3

                WHEN games_owned
                  BETWEEN 251 AND 500
                  THEN 4

                WHEN games_owned
                  BETWEEN 501 AND 1000
                  THEN 5

                WHEN games_owned >= 1001
                  THEN 6

              END
                AS cohort_order


            FROM profile_stats


            WHERE games_owned > 0
          )


          SELECT

            cohort,

            cohort_order,


            /*
             * Number of profiles represented
             * in this cohort.
             */
            COUNT(*)::integer
              AS sample_size,


            /*
             * Total games represented across
             * all profiles in the cohort.
             */
            SUM(games_owned)::bigint
              AS total_games,


            /*
             * Total zero-playtime games.
             */
            SUM(unplayed_games)::bigint
              AS unplayed_games,


            /*
             * Overall percentage of games in
             * this cohort with zero playtime.
             */
            ROUND(
              (
                SUM(unplayed_games)::numeric
                /
                NULLIF(
                  SUM(games_owned),
                  0
                )
                * 100
              ),
              2
            )
              AS unplayed_percentage,


            /*
             * This is intentionally NOT the
             * median of every game pooled together.
             *
             * Each user contributes one median,
             * then we take the median of those
             * profile medians.
             */
            ROUND(
              (
                PERCENTILE_CONT(0.5)
                WITHIN GROUP (
                  ORDER BY
                    median_playtime_minutes
                )
                /
                60.0
              )::numeric,
              2
            )
              AS median_playtime_hours


          FROM cohort_profiles


          WHERE cohort IS NOT NULL


          GROUP BY
            cohort,
            cohort_order


          ORDER BY
            cohort_order
        `
      );


      /*
       * PostgreSQL NUMERIC/BIGINT fields can
       * arrive as strings through node-postgres,
       * so normalize the API response.
       */
      const cohorts =
        result.rows.map(
          row => ({

            cohort:
              row.cohort,

            sampleSize:
              Number(
                row.sample_size
              ),

            totalGames:
              Number(
                row.total_games
              ),

            unplayedGames:
              Number(
                row.unplayed_games
              ),

            unplayedPercentage:
              Number(
                row.unplayed_percentage
              ),

            medianPlaytimeHours:
              Number(
                row.median_playtime_hours
              )
          })
        );


      res.json({

        generatedAt:
          new Date().toISOString(),

        includedProfiles:
          cohorts.reduce(
            (sum, cohort) =>
              sum + cohort.sampleSize,
            0
          ),

        cohorts
      });
  } catch (error) {
    console.error(error);
     res.status(500).json({error: "Could calculate cohort analysis."});
  }
  }
);

router.get("/backfill-playtime-status", requireAdmin, requireTrustedOrigin, async (req, res) => {
    try {
        const result = await backfillPlaytimeAvailability();
        res.json({success: true, ...result});
    } catch (error) {
        console.error(error);
        res.status(500).json({success: false, error: "Backfill failed.", message: error.message});
    }
  }
);

router.get("/profileszeropt", async (req, res) => {
  try {

      const result = await pool.query(
          `
            SELECT  *
            FROM steam_profiles
            WHERE playtime_available = false
            ORDER BY first_collected_at DESC;
          `
        );

      res.json(result.rows);

  } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          "Could not retrieve profile."
      });
    }
});

router.get("/pt_status", async (req, res) => {
  try {

      const result = await pool.query(
          `
            SELECT
              playtime_status,
               playtime_available,
              COUNT(*)

            FROM steam_profiles

            GROUP BY
              playtime_status,
              playtime_available

            ORDER BY
              playtime_status;
          `
        );

      res.json(result.rows);

  } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          "Could not retrieve profile."
      });
    }
});

router.get("/suspicious", async (req, res) => {
  try {

      const result = await pool.query(
          `
            SELECT
              p.steamid,
              p.personaname,
              p.reported_game_count,

              COUNT(g.appid) AS stored_games,

              SUM(
                g.playtime_forever_minutes
              ) AS total_minutes

            FROM steam_profiles p

            JOIN steam_profile_games g
                  ON g.steamid = p.steamid

            WHERE
                  p.playtime_status = 'all_zero'

            GROUP BY
                  p.steamid,
                  p.personaname,
                  p.reported_game_count

            ORDER BY
                  stored_games DESC;
          `
        );

      res.json(result.rows);

  } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          "Could not retrieve profile."
      });
    }
});

router.get("/ck_null", async (req, res) => {
  try {

      const result = await pool.query(
          `
            SELECT COUNT(*)

            FROM steam_profiles

            WHERE playtime_available IS NULL
              AND playtime_status IS NULL;
          `
        );

      res.json(result.rows);

  } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          "Could not retrieve profile."
      });
    }
});

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
        ).trim();


      if (
        q.length < 2
      ) {

        return res
          .status(400)
          .json({
            error:
              "Enter at least 2 characters."
          });
      }


      const requestedLimit =
        Number(
          req.query.limit ||
          10
        );


      const limit =
        Math.min(
          Math.max(
            requestedLimit,
            1
          ),
          20
        );


      /*
       * POSITION avoids treating %
       * and _ as LIKE wildcards.
       */
      const result =
        await pool.query(
          `
            SELECT

              steamid,
              personaname,
              profile_url,
              avatar_url,
              games_visible,
              reported_game_count,
              playtime_available,
              playtime_status,
              last_collected_at

            FROM steam_profiles

            WHERE

              steamid = $1

              OR

              POSITION(
                LOWER($1)
                IN
                LOWER(
                  COALESCE(
                    personaname,
                    ''
                  )
                )
              ) > 0


            ORDER BY

              CASE

                WHEN steamid = $1
                  THEN 0

                WHEN LOWER(personaname) =
                     LOWER($1)
                  THEN 1

                WHEN LEFT(
                       LOWER(personaname),
                       LENGTH($1)
                     ) =
                     LOWER($1)
                  THEN 2

                ELSE 3

              END,

              last_collected_at
                DESC NULLS LAST


            LIMIT $2
          `,
          [
            q,
            limit
          ]
        );


      res.json({

        query:
          q,

        count:
          result.rows.length,

        profiles:
          result.rows.map(
            row => ({

              steamid:
                row.steamid,

              personaname:
                row.personaname,

              profileUrl:
                row.profile_url,

              avatarUrl:
                row.avatar_url,

              gamesVisible:
                row.games_visible,

              reportedGameCount:
                row.reported_game_count === null
                  ? null
                  : Number(
                      row.reported_game_count
                    ),

              playtimeAvailable:
                row.playtime_available,

              playtimeStatus:
                row.playtime_status,

              lastCollectedAt:
                row.last_collected_at
            })
          )
      });


    } catch (error) {

      console.error(
        "Profile search failed:",
        error
      );


      res
        .status(500)
        .json({

          error:
            "Could not search Steam profiles.",

          message:
            error.message
        });
    }
  }
);

router.get("/:steamid", async (req, res) => {

    const steamid = req.params.steamid;

    if (!validSteamId(steamid)) {

      return res.status(400).json({
        error:
          "Invalid SteamID64."
      });
    }


    try {

      const result = await pool.query(
          `
            SELECT *
            FROM steam_profiles
            WHERE steamid = $1
          `,
          [steamid]
        );


      if (
        result.rows.length === 0
      ) {
        return res
          .status(404)
          .json({
            error:
              "Profile has not been collected."
          });
      }

      const row =
        result.rows[0];


/*       const statsResult =
        await pool.query(
          `
            SELECT

              COUNT(*)::integer
                AS stored_game_count,

              COUNT(*) FILTER (
                WHERE
                  playtime_forever_minutes = 0
              )::integer
                AS never_played_games,

              COUNT(*) FILTER (
                WHERE
                  playtime_forever_minutes > 0
                  AND
                  playtime_forever_minutes < 60
              )::integer
                AS under_one_hour_games,

              COALESCE(
                SUM(
                  playtime_forever_minutes
                ),
                0
              )
                AS total_playtime_minutes

            FROM steam_profile_games

            WHERE steamid = $1
          `,
          [steamid]
        ); */


      res.json({

        steamid:
          row.steamid,

        personaname:
          row.personaname,

        profileUrl:
          row.profile_url,

        avatarUrl:
          row.avatar_url,

        communityVisibilityState:
          row.community_visibility_state,

        gamesVisible:
          row.games_visible,

        reportedGameCount:
          row.reported_game_count === null
            ? null
            : Number(
                row.reported_game_count
              ),

        playtimeAvailable:
          row.playtime_available,

        playtimeStatus:
          row.playtime_status,

        firstCollectedAt:
          row.first_collected_at,

        lastCollectedAt:
          row.last_collected_at

        /* profile:
          profileResult.rows[0],

         stats:
          statsResult.rows[0] */
      });


    } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          "Could not retrieve profile."
      });
    }
  }
);

router.get(
  "/:steamid/games",

  async (
    req,
    res
  ) => {

    const {
      steamid
    } =
      req.params;


    if (
      !validSteamId(
        steamid
      )
    ) {

      return res
        .status(400)
        .json({
          error:
            "Invalid SteamID64."
        });
    }


    const requestedPage =
      Math.max(
        Number(
          req.query.page ||
          1
        ),
        1
      );


    const limit =
      Math.min(
        Math.max(
          Number(
            req.query.limit ||
            25
          ),
          10
        ),
        100
      );


    const search =
      String(
        req.query.search ||
        ""
      )
        .trim()
        .slice(
          0,
          100
        );


    const sort =
      String(
        req.query.sort ||
        "playtime"
      );


    const order =
      String(
        req.query.order ||
        "desc"
      )
        .toLowerCase() ===
        "asc"
          ? "ASC"
          : "DESC";


    /*
     * Never interpolate arbitrary user input
     * into ORDER BY.
     */
    const sortColumns = {

      name:
        "LOWER(COALESCE(name, ''))",

      playtime:
        "playtime_forever_minutes",

      recent:
        "COALESCE(playtime_2weeks_minutes, 0)",

      lastPlayed:
        "last_played_at",

      appid:
        "appid"
    };


    const sortColumn =
      sortColumns[sort] ||
      sortColumns.playtime;


    try {

      const profileResult =
        await pool.query(
          `
            SELECT
              games_visible,
              playtime_available

            FROM steam_profiles

            WHERE steamid = $1
          `,
          [
            steamid
          ]
        );


      if (
        profileResult.rows.length === 0
      ) {

        return res
          .status(404)
          .json({
            error:
              "Profile has not been collected."
          });
      }


      const profile =
        profileResult.rows[0];


      if (
        profile.games_visible !== true
      ) {

        return res
          .status(403)
          .json({
            error:
              "This profile's game library is not currently public."
          });
      }


      const countResult =
        await pool.query(
          `
            SELECT
              COUNT(*)::integer
                AS total

            FROM steam_profile_games

            WHERE
              steamid = $1

              AND
              (
                $2 = ''

                OR

                POSITION(
                  LOWER($2)
                  IN
                  LOWER(
                    COALESCE(
                      name,
                      ''
                    )
                  )
                ) > 0
              )
          `,
          [
            steamid,
            search
          ]
        );


      const total =
        Number(
          countResult
            .rows[0]
            .total
        );


      const totalPages =
        Math.max(
          1,
          Math.ceil(
            total /
            limit
          )
        );


      const page =
        Math.min(
          requestedPage,
          totalPages
        );


      const offset =
        (
          page - 1
        ) *
        limit;


      const result =
        await pool.query(
          `
            SELECT

              appid,
              name,
              playtime_forever_minutes,
              playtime_2weeks_minutes,
              last_played_at,
              collected_at

            FROM steam_profile_games

            WHERE
              steamid = $1

              AND
              (
                $2 = ''

                OR

                POSITION(
                  LOWER($2)
                  IN
                  LOWER(
                    COALESCE(
                      name,
                      ''
                    )
                  )
                ) > 0
              )

            ORDER BY
              ${sortColumn}
              ${order}
              NULLS LAST,

              appid ASC

            LIMIT $3
            OFFSET $4
          `,
          [
            steamid,
            search,
            limit,
            offset
          ]
        );


      /*
       * If playtime isn't usable, don't send
       * misleading zero values to the frontend.
       */
      const exposePlaytime =
        profile.playtime_available ===
        true;


      res.json({

        steamid,

        page,

        pageSize:
          limit,

        total,

        totalPages,

        sort,

        order:
          order.toLowerCase(),

        search,

        games:
          result.rows.map(
            game => ({

              appid:
                Number(
                  game.appid
                ),

              name:
                game.name,

              playtimeForeverMinutes:
                exposePlaytime
                  ? Number(
                      game.playtime_forever_minutes
                    )
                  : null,

              playtime2WeeksMinutes:
                exposePlaytime &&
                game.playtime_2weeks_minutes !==
                  null
                  ? Number(
                      game.playtime_2weeks_minutes
                    )
                  : null,

              lastPlayedAt:
                exposePlaytime
                  ? game.last_played_at
                  : null,

              collectedAt:
                game.collected_at
            })
          )
      });


    } catch (error) {

      console.error(
        "Game library query failed:",
        error
      );


      res
        .status(500)
        .json({

          error:
            "Could not retrieve Steam game library.",

          message:
            error.message
        });
    }
  }
);

router.get("/:steamid/gamesold", async (req, res) => {

    const steamid = req.params.steamid;

    if (!validSteamId(steamid)) {

      return res.status(400).json({
        error:
          "Invalid SteamID64."
      });
    }

    try {

      const profileResult = await pool.query(
          `
            SELECT
              games_visible
            FROM steam_profiles
            WHERE steamid = $1
          `,
          [steamid]
        );

      if (
        profileResult.rows.length === 0
      ) {

        return res
          .status(404)
          .json({
            error:
              "Profile has not been collected."
          });
      }

      if (
        !profileResult.rows[0]
          .games_visible
      ) {

        return res
          .status(403)
          .json({
            error:
              "Game details are not publicly visible."
          });
      }

      const conditions = [
        "steamid = $1"
      ];

      const parameters = [
        steamid
      ];

      /*
       * Example:
       *
       * ?unplayed=true
       */
      if (
        req.query.unplayed === "true"
      ) {

        conditions.push(
          "playtime_forever_minutes = 0"
        );
      }

      const allowedSorts = {

        name:
          "name",

        playtime:
          "playtime_forever_minutes",

        lastplayed:
          "last_played_at"
      };


      const sortColumn =
        allowedSorts[
          req.query.sort
        ] ??
        "playtime_forever_minutes";


      const sortOrder =
        String(
          req.query.order
        ).toLowerCase() === "asc"
          ? "ASC"
          : "DESC";


      const result =
        await pool.query(
          `
            SELECT

              appid,

              name,

              playtime_forever_minutes,

              playtime_2weeks_minutes,

              playtime_windows_forever_minutes,

              playtime_mac_forever_minutes,

              playtime_linux_forever_minutes,

              last_played_at,

              has_community_visible_stats,

              collected_at

            FROM steam_profile_games

            WHERE
              ${conditions.join(" AND ")}

            ORDER BY
              ${sortColumn}
              ${sortOrder}
              NULLS LAST
          `,
          parameters
        );


      const games =
        result.rows.map(
          game => ({

            ...game,

            hours_played:
              Number(
                (
                  game
                    .playtime_forever_minutes /
                  60
                ).toFixed(2)
              ),
          })
        );


      res.json({
        steamid,
        count: games.length,
        games
      });


    } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          "Could not retrieve games."
      });
    }
  }
);

router.get(
  "/:steamid/analysis",

  async (
    req,
    res
  ) => {

    const {
      steamid
    } =
      req.params;


    if (
      !validSteamId(
        steamid
      )
    ) {

      return res
        .status(400)
        .json({
          error:
            "Invalid SteamID64."
        });
    }


    try {

      const profileResult =
        await pool.query(
          `
            SELECT

              steamid,
              games_visible,
              playtime_available,
              playtime_status,
              reported_game_count

            FROM steam_profiles

            WHERE steamid = $1
          `,
          [
            steamid
          ]
        );


      if (
        profileResult.rows.length === 0
      ) {

        return res
          .status(404)
          .json({
            error:
              "Profile has not been collected."
          });
      }


      const profile =
        profileResult.rows[0];


      /*
       * Do not expose previously stored library
       * information if the profile is currently
       * classified as game-details private.
       */
      if (
        profile.games_visible !== true
      ) {

        return res.json({

          steamid,

          gamesVisible:
            false,

          playtimeAvailable:
            null,

          playtimeStatus:
            "game_details_private",

          totalGames:
            null,

          totalPlaytimeHours:
            null,

          medianPlaytimeHours:
            null,

          medianPlayedGameHours:
            null,

          averagePlaytimeHours:
            null,

          neverPlayedGames:
            null,

          neverPlayedPercentage:
            null,

          playtimeBuckets:
            [],

          topGames:
            []
        });
      }


      /*
       * Count games even when playtime is hidden.
       */
      const gameCountResult =
        await pool.query(
          `
            SELECT
              COUNT(*)::integer
                AS total_games

            FROM steam_profile_games

            WHERE steamid = $1
          `,
          [
            steamid
          ]
        );


      const totalGames =
        Number(
          gameCountResult
            .rows[0]
            .total_games
        );


      /*
       * We know the library, but should not
       * interpret the all-zero playtime values.
       */
      if (
        profile.playtime_available !== true
      ) {

        return res.json({

          steamid,

          gamesVisible:
            true,

          playtimeAvailable:
            false,

          playtimeStatus:
            profile.playtime_status,

          totalGames,

          totalPlaytimeHours:
            null,

          medianPlaytimeHours:
            null,

          medianPlayedGameHours:
            null,

          averagePlaytimeHours:
            null,

          neverPlayedGames:
            null,

          neverPlayedPercentage:
            null,

          playtimeBuckets:
            [],

          topGames:
            []
        });
      }


      const [
        statsResult,
        topGamesResult
      ] =
        await Promise.all([

          pool.query(
            `
              SELECT

                COUNT(*)::integer
                  AS total_games,


                COALESCE(
                  SUM(
                    playtime_forever_minutes
                  ),
                  0
                )::bigint
                  AS total_playtime_minutes,


                AVG(
                  playtime_forever_minutes
                )
                  AS average_playtime_minutes,


                PERCENTILE_CONT(0.5)
                WITHIN GROUP (
                  ORDER BY
                    playtime_forever_minutes
                )
                  AS median_playtime_minutes,


                PERCENTILE_CONT(0.5)
                WITHIN GROUP (
                  ORDER BY
                    playtime_forever_minutes
                )
                FILTER (
                  WHERE
                    playtime_forever_minutes > 0
                )
                  AS median_played_minutes,


                COUNT(*) FILTER (
                  WHERE
                    playtime_forever_minutes = 0
                )::integer
                  AS never_played,


                COUNT(*) FILTER (
                  WHERE
                    playtime_forever_minutes > 0
                    AND
                    playtime_forever_minutes < 60
                )::integer
                  AS under_one_hour,


                COUNT(*) FILTER (
                  WHERE
                    playtime_forever_minutes >= 60
                    AND
                    playtime_forever_minutes < 300
                )::integer
                  AS one_to_five_hours,


                COUNT(*) FILTER (
                  WHERE
                    playtime_forever_minutes >= 300
                    AND
                    playtime_forever_minutes < 1200
                )::integer
                  AS five_to_twenty_hours,


                COUNT(*) FILTER (
                  WHERE
                    playtime_forever_minutes >= 1200
                    AND
                    playtime_forever_minutes < 6000
                )::integer
                  AS twenty_to_one_hundred_hours,


                COUNT(*) FILTER (
                  WHERE
                    playtime_forever_minutes >= 6000
                )::integer
                  AS over_one_hundred_hours


              FROM steam_profile_games

              WHERE steamid = $1
            `,
            [
              steamid
            ]
          ),


          pool.query(
            `
              SELECT

                appid,
                name,
                playtime_forever_minutes

              FROM steam_profile_games

              WHERE steamid = $1

              ORDER BY
                playtime_forever_minutes DESC,
                name ASC

              LIMIT 10
            `,
            [
              steamid
            ]
          )

        ]);


      const stats =
        statsResult.rows[0];


      const total =
        Number(
          stats.total_games
        );


      const neverPlayed =
        Number(
          stats.never_played
        );


      res.json({

        steamid,

        gamesVisible:
          true,

        playtimeAvailable:
          true,

        playtimeStatus:
          "available",

        totalGames:
          total,

        totalPlaytimeHours:
          minutesToHours(
            stats.total_playtime_minutes
          ),

        averagePlaytimeHours:
          minutesToHours(
            stats.average_playtime_minutes
          ),

        medianPlaytimeHours:
          minutesToHours(
            stats.median_playtime_minutes,
            2
          ),

        medianPlayedGameHours:
          minutesToHours(
            stats.median_played_minutes,
            2
          ),

        neverPlayedGames:
          neverPlayed,

        neverPlayedPercentage:
          total > 0
            ? Number(
                (
                  neverPlayed /
                  total *
                  100
                ).toFixed(1)
              )
            : 0,


        playtimeBuckets: [

          {
            key:
              "unplayed",

            label:
              "Unplayed",

            count:
              neverPlayed
          },

          {
            key:
              "under1",

            label:
              "< 1 hr",

            count:
              Number(
                stats.under_one_hour
              )
          },

          {
            key:
              "1to5",

            label:
              "1–5 hrs",

            count:
              Number(
                stats.one_to_five_hours
              )
          },

          {
            key:
              "5to20",

            label:
              "5–20 hrs",

            count:
              Number(
                stats.five_to_twenty_hours
              )
          },

          {
            key:
              "20to100",

            label:
              "20–100 hrs",

            count:
              Number(
                stats.twenty_to_one_hundred_hours
              )
          },

          {
            key:
              "100plus",

            label:
              "100+ hrs",

            count:
              Number(
                stats.over_one_hundred_hours
              )
          }
        ],


        topGames:
          topGamesResult.rows.map(
            game => ({

              appid:
                Number(
                  game.appid
                ),

              name:
                game.name,

              playtimeHours:
                minutesToHours(
                  game.playtime_forever_minutes
                )
            })
          )
      });


    } catch (error) {

      console.error(
        "Profile analysis failed:",
        error
      );


      res
        .status(500)
        .json({

          error:
            "Could not analyze Steam profile.",

          message:
            error.message
        });
    }
  }
);

router.get("/:steamid/analysisold", async (req, res) => {

    const { steamid } =
      req.params;

    if (!validSteamId(steamid)) {

      return res.status(400).json({
        error:
          "Invalid SteamID64."
      });
    }

    try {

      const result =
        await pool.query(
          `
            SELECT

              COUNT(*)::integer
                AS total_games,

            AVG(playtime_forever_minutes) / 60.0
                AS average_hours_per_game,

            PERCENTILE_CONT(0.5)
            WITHIN GROUP (
                ORDER BY playtime_forever_minutes
            ) / 60.0
                AS median_hours_per_game,

            PERCENTILE_CONT(0.5)
            WITHIN GROUP (
                ORDER BY playtime_forever_minutes
            )
            FILTER (
                WHERE playtime_forever_minutes > 0
            ) / 60.0
                AS median_hours_played_games_only,


              COUNT(*) FILTER (
                WHERE
                  playtime_forever_minutes = 0
              )::integer
                AS never_played_games,


              COUNT(*) FILTER (
                WHERE
                  playtime_forever_minutes > 0
                  AND
                  playtime_forever_minutes < 60
              )::integer
                AS under_one_hour_games,


              COUNT(*) FILTER (
                WHERE
                  playtime_forever_minutes > 0
                  AND
                  playtime_forever_minutes < 300
              )::integer
                AS under_five_hour_games,

                 COUNT(*) FILTER (
            WHERE playtime_forever_minutes >= 6000
            )::integer
            AS over_100_hour_games,

              COALESCE(
                SUM(
                  playtime_forever_minutes
                ),
                0
              )
                AS total_playtime_minutes

            FROM steam_profile_games

            WHERE steamid = $1
          `,
          [steamid]
        );


      const stats =
        result.rows[0];


      const total =
        stats.total_games;


      res.json({

        steamid,

        average_hours_per_game:
          stats.average_hours_per_game,

        median_hours_per_game:
          stats.median_hours_per_game,
        
        median_hours_played_games_only:
          stats.median_hours_played_games_only,

        total_games:
          total,

        never_played_games:
          stats.never_played_games,

        never_played_percentage:
          total > 0
            ? Number(
                (
                  stats.never_played_games /
                  total *
                  100
                ).toFixed(1)
              )
            : 0,


        under_one_hour_games:
          stats.under_one_hour_games,

        under_one_hour_percentage:
          total > 0
            ? Number(
                (
                  stats.under_one_hour_games /
                  total *
                  100
                ).toFixed(1)
              )
            : 0,


        under_five_hour_games:
          stats.under_five_hour_games,

        under_five_hour_percentage:
          total > 0
            ? Number(
                (
                  stats.under_five_hour_games /
                  total *
                  100
                ).toFixed(1)
              )
            : 0,

        total_hours:
          Number(
            (
              Number(
                stats.total_playtime_minutes
              ) /
              60
            ).toFixed(1)
          )
      });


    } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          "Could not analyze profile."
      });
    }
  }
);

router.get("/:steamid/friendList", async (req, res) => {

    const steamid = req.params.steamid;

    if (!validSteamId(steamid)) {

      return res.status(400).json({
        error:
          "Invalid SteamID64."
      });
    }

    try {

        const friendList = await getFriendList(steamid);
        res.json({
            steamid,
            friendList
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
        error: "Could not retrieve friend list."
        });
    }
});

export default router;
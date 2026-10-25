import express from "express";
import { pool } from "./db.js";

const router = express.Router();

router.get(
  "/profile-spotlights",

  async (
    req,
    res
  ) => {

    try {

      const result =
        await pool.query(
          `
            SELECT

              spotlight.generated_at,


              ll.steamid
                AS ll_steamid,

              ll.personaname
                AS ll_personaname,

              ll.profile_url
                AS ll_profile_url,

              ll.avatar_url
                AS ll_avatar_url,

              ll.last_collected_at
                AS ll_last_collected_at,

              lls.games_owned
                AS ll_games_owned,

              lls.total_playtime_minutes
                AS ll_total_playtime_minutes,

              lls.unplayed_games
                AS ll_unplayed_games,

              lls.unplayed_percentage
                AS ll_unplayed_percentage,


              mp.steamid
                AS mp_steamid,

              mp.personaname
                AS mp_personaname,

              mp.profile_url
                AS mp_profile_url,

              mp.avatar_url
                AS mp_avatar_url,

              mp.last_collected_at
                AS mp_last_collected_at,

              mps.games_owned
                AS mp_games_owned,

              mps.total_playtime_minutes
                AS mp_total_playtime_minutes,

              mps.unplayed_games
                AS mp_unplayed_games,

              mps.unplayed_percentage
                AS mp_unplayed_percentage,


              hu.steamid
                AS hu_steamid,

              hu.personaname
                AS hu_personaname,

              hu.profile_url
                AS hu_profile_url,

              hu.avatar_url
                AS hu_avatar_url,

              hu.last_collected_at
                AS hu_last_collected_at,

              hus.games_owned
                AS hu_games_owned,

              hus.total_playtime_minutes
                AS hu_total_playtime_minutes,

              hus.unplayed_games
                AS hu_unplayed_games,

              hus.unplayed_percentage
                AS hu_unplayed_percentage


            FROM profile_spotlight_statistics spotlight


            LEFT JOIN steam_profiles ll

              ON ll.steamid =
                 spotlight.largest_library_steamid


            LEFT JOIN steam_profile_statistics lls

              ON lls.steamid =
                 spotlight.largest_library_steamid


            LEFT JOIN steam_profiles mp

              ON mp.steamid =
                 spotlight.most_playtime_steamid


            LEFT JOIN steam_profile_statistics mps

              ON mps.steamid =
                 spotlight.most_playtime_steamid


            LEFT JOIN steam_profiles hu

              ON hu.steamid =
                 spotlight.highest_unplayed_steamid


            LEFT JOIN steam_profile_statistics hus

              ON hus.steamid =
                 spotlight.highest_unplayed_steamid


            WHERE
              spotlight.id = 1
          `
        );


      if (
        result.rows.length === 0
      ) {

        return res.json({

          largestLibrary:
            null,

          mostPlaytime:
            null,

          highestUnplayedPercentage:
            null,

          generatedAt:
            null
        });
      }


      const row =
        result.rows[0];


      function createSpotlight(
        prefix
      ) {

        const steamid =
          row[
            `${prefix}_steamid`
          ];


        if (!steamid) {

          return null;
        }


        const totalMinutes =
          Number(
            row[
              `${prefix}_total_playtime_minutes`
            ] || 0
          );


        return {

          steamid,

          personaname:
            row[
              `${prefix}_personaname`
            ],

          profileUrl:
            row[
              `${prefix}_profile_url`
            ],

          avatarUrl:
            row[
              `${prefix}_avatar_url`
            ],

          gamesOwned:
            Number(
              row[
                `${prefix}_games_owned`
              ] || 0
            ),

          totalPlaytimeHours:
            Number(
              (
                totalMinutes /
                60
              ).toFixed(1)
            ),

          unplayedGames:
            Number(
              row[
                `${prefix}_unplayed_games`
              ] || 0
            ),

          unplayedPercentage:
            Number(
              row[
                `${prefix}_unplayed_percentage`
              ] || 0
            ),

          lastCollectedAt:
            row[
              `${prefix}_last_collected_at`
            ]
        };
      }


      res.json({

        largestLibrary:
          createSpotlight(
            "ll"
          ),

        mostPlaytime:
          createSpotlight(
            "mp"
          ),

        highestUnplayedPercentage:
          createSpotlight(
            "hu"
          ),

        generatedAt:
          row.generated_at
      });


    } catch (error) {

      console.error(
        "Profile spotlight retrieval failed:",
        error
      );


      res
        .status(500)
        .json({

          error:
            "Could not retrieve profile spotlights.",

          message:
            error.message
        });
    }
  }
);

/*
 router.get(
  "/profile-spotlights",

  async (req, res) => {

    const client =
      await pool.connect();


    try {

      await client.query(
        "BEGIN"
      );


      
        //Safety valve since this query aggregates
        //the profile-game dataset.
       

      await client.query(
        `
          SET LOCAL
          statement_timeout = '60000ms'
        `
      );


      const result =
        await client.query(
          `
            WITH profile_stats AS (

              SELECT

                p.steamid,
                p.personaname,
                p.profile_url,
                p.avatar_url,
                p.reported_game_count,
                p.last_collected_at,


                COUNT(
                  g.appid
                )::bigint
                  AS games_owned,


                COALESCE(
                  SUM(
                    g.playtime_forever_minutes
                  ),
                  0
                )::bigint
                  AS total_playtime_minutes,


                COUNT(*) FILTER (
                  WHERE
                    g.playtime_forever_minutes = 0
                )::bigint
                  AS unplayed_games


              FROM steam_profiles p


              INNER JOIN steam_profile_games g

                ON g.steamid =
                   p.steamid


              WHERE

                p.games_visible = TRUE

                AND

                p.playtime_available = TRUE


              GROUP BY

                p.steamid,
                p.personaname,
                p.profile_url,
                p.avatar_url,
                p.reported_game_count,
                p.last_collected_at
            ),


            profile_metrics AS (

              SELECT

                *,

                ROUND(
                  total_playtime_minutes
                  / 60.0,
                  1
                )
                  AS total_playtime_hours,


                CASE

                  WHEN games_owned > 0

                  THEN

                    ROUND(
                      (
                        unplayed_games::numeric
                        /
                        games_owned
                      ) * 100,
                      1
                    )

                  ELSE 0

                END
                  AS unplayed_percentage


              FROM profile_stats
            ),


            largest_library AS (

              SELECT *

              FROM profile_metrics

              ORDER BY

                games_owned DESC,

                total_playtime_minutes DESC,

                steamid ASC

              LIMIT 1
            ),


            most_playtime AS (

              SELECT *

              FROM profile_metrics

              ORDER BY

                total_playtime_minutes DESC,

                games_owned DESC,

                steamid ASC

              LIMIT 1
            ),


            highest_unplayed AS (

              SELECT *

              FROM profile_metrics

              WHERE
                games_owned > 0

              ORDER BY

                unplayed_percentage DESC,

                games_owned DESC,

                total_playtime_minutes DESC,

                steamid ASC

              LIMIT 1
            )


            SELECT


              (
                SELECT

                  json_build_object(

                    'steamid',
                      steamid,

                    'personaname',
                      personaname,

                    'profileUrl',
                      profile_url,

                    'avatarUrl',
                      avatar_url,

                    'gamesOwned',
                      games_owned,

                    'reportedGameCount',
                      reported_game_count,

                    'totalPlaytimeHours',
                      total_playtime_hours,

                    'unplayedGames',
                      unplayed_games,

                    'unplayedPercentage',
                      unplayed_percentage,

                    'lastCollectedAt',
                      last_collected_at
                  )

                FROM largest_library
              )
                AS largest_library,


              (
                SELECT

                  json_build_object(

                    'steamid',
                      steamid,

                    'personaname',
                      personaname,

                    'profileUrl',
                      profile_url,

                    'avatarUrl',
                      avatar_url,

                    'gamesOwned',
                      games_owned,

                    'reportedGameCount',
                      reported_game_count,

                    'totalPlaytimeHours',
                      total_playtime_hours,

                    'unplayedGames',
                      unplayed_games,

                    'unplayedPercentage',
                      unplayed_percentage,

                    'lastCollectedAt',
                      last_collected_at
                  )

                FROM most_playtime
              )
                AS most_playtime,


              (
                SELECT

                  json_build_object(

                    'steamid',
                      steamid,

                    'personaname',
                      personaname,

                    'profileUrl',
                      profile_url,

                    'avatarUrl',
                      avatar_url,

                    'gamesOwned',
                      games_owned,

                    'reportedGameCount',
                      reported_game_count,

                    'totalPlaytimeHours',
                      total_playtime_hours,

                    'unplayedGames',
                      unplayed_games,

                    'unplayedPercentage',
                      unplayed_percentage,

                    'lastCollectedAt',
                      last_collected_at
                  )

                FROM highest_unplayed
              )
                AS highest_unplayed_percentage
          `
        );


      await client.query(
        "COMMIT"
      );


      const row =
        result.rows[0];


      res.json({

        largestLibrary:
          row.largest_library,

        mostPlaytime:
          row.most_playtime,

        highestUnplayedPercentage:
          row.highest_unplayed_percentage
      });


    } catch (error) {

      try {

        await client.query(
          "ROLLBACK"
        );

      } catch {

        // Ignore rollback errors.
      }


      console.error(
        "Profile spotlights failed:",
        error
      );


      if (
        error.code ===
        "57014"
      ) {

        return res
          .status(503)
          .json({
            error:
              "Profile spotlight query timed out."
          });
      }


      res
        .status(500)
        .json({

          error:
            "Could not retrieve profile spotlights.",

          message:
            error.message
        });


    } finally {

      client.release();
    }
  }
);
*/

export default router;
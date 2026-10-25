import {
  pool
} from "./db.js";


export async function refreshDashboardStatistics() {

  const client =
    await pool.connect();


  try {

    await client.query(
      "BEGIN"
    );


    /*
     * IMPORTANT:
     * Because this is SET LOCAL,
     * the aggregation below MUST also
     * use client.query(), not pool.query().
     */
    await client.query(
      `
        SET LOCAL
        statement_timeout = '40000ms'
      `
    );
      const result = await client.query(
        `
          INSERT INTO dashboard_statistics (

          id,
          profiles_analyzed,
          average_library_size,
          owned_games,
          unplayed_games,
          generated_at
      )

      SELECT

          1,

          COUNT(*)::bigint,

          COALESCE(
              AVG(games_owned),
              0
          )::numeric,

          COALESCE(
              SUM(games_owned),
              0
          )::bigint,

          COALESCE(
              SUM(unplayed_games),
              0
          )::bigint,

          NOW()

      FROM steam_profile_statistics

      ON CONFLICT (id)

      DO UPDATE SET

          profiles_analyzed =
              EXCLUDED.profiles_analyzed,

          average_library_size =
              EXCLUDED.average_library_size,

          owned_games =
              EXCLUDED.owned_games,

          unplayed_games =
              EXCLUDED.unplayed_games,

          generated_at =
              EXCLUDED.generated_at

      RETURNING

          profiles_analyzed,
          average_library_size,
          owned_games,
          unplayed_games,
          generated_at;
        `
      );

    /* const result =
      await client.query(
        `
          WITH profile_stats AS (

            SELECT

              COUNT(*)::bigint
                AS profiles_analyzed,

              AVG(
                reported_game_count
              )::numeric
                AS avg_lib_size

            FROM steam_profiles

            WHERE
              games_visible = TRUE

              AND
              playtime_available = TRUE
          ),


          game_stats AS (

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

              ON p.steamid =
                 g.steamid


            WHERE
              p.games_visible = TRUE

              AND
              p.playtime_available = TRUE
          )


          INSERT INTO dashboard_statistics (

            id,

            profiles_analyzed,

            average_library_size,

            owned_games,

            unplayed_games,

            generated_at

          )


          SELECT

            1,

            profile_stats.profiles_analyzed,

            profile_stats.avg_lib_size,

            game_stats.owned_games,

            game_stats.unplayed_games,

            NOW()


          FROM profile_stats

          CROSS JOIN game_stats


          ON CONFLICT (id)

          DO UPDATE SET

            profiles_analyzed =
              EXCLUDED.profiles_analyzed,

            average_library_size =
              EXCLUDED.average_library_size,

            owned_games =
              EXCLUDED.owned_games,

            unplayed_games =
              EXCLUDED.unplayed_games,

            generated_at =
              EXCLUDED.generated_at


          RETURNING

            profiles_analyzed,

            average_library_size,

            owned_games,

            unplayed_games,

            generated_at
        `
      ); */


    await client.query(
      "COMMIT"
    );


    const row =
      result.rows[0];


    return {

      profilesAnalyzed:
        Number(
          row.profiles_analyzed
        ),

      averageLibrarySize:
        row.average_library_size ===
        null
          ? 0
          : Number(
              Number(
                row.average_library_size
              ).toFixed(1)
            ),

      ownedGames:
        Number(
          row.owned_games
        ),

      unplayedGames:
        Number(
          row.unplayed_games
        ),

      generatedAt:
        row.generated_at
    };


  } catch (error) {

    try {

      await client.query(
        "ROLLBACK"
      );

    } catch {

      // Ignore rollback errors.
    }


    if (
      error.code ===
      "57014"
    ) {

      console.error(
        "Dashboard statistics refresh timed out."
      );

    } else {

      console.error(
        "Dashboard statistics refresh failed:",
        error
      );
    }


    throw error;


  } finally {

    client.release();
  }
}
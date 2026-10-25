import {
  pool
} from "./db.js";


export async function refreshProfileStatistics(
  steamid
) {

  /*
   * First determine whether this profile
   * still qualifies for playtime analysis.
   */
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


  /*
   * Profile disappeared.
   */
  if (
    profileResult.rows.length === 0
  ) {

    await pool.query(
      `
        DELETE FROM
          steam_profile_statistics

        WHERE steamid = $1
      `,
      [
        steamid
      ]
    );


    return null;
  }


  const profile =
    profileResult.rows[0];


  /*
   * A private library or unusable playtime
   * must not remain in our analysis table.
   */
  if (
    profile.games_visible !== true ||
    profile.playtime_available !== true
  ) {

    await pool.query(
      `
        DELETE FROM
          steam_profile_statistics

        WHERE steamid = $1
      `,
      [
        steamid
      ]
    );


    return null;
  }


  /*
   * This query now scans ONLY this user's
   * games, not the complete research dataset.
   *
   * The PK on (steamid, appid) makes this
   * lookup efficient.
   */
  const result =
    await pool.query(
      `
        INSERT INTO steam_profile_statistics (

          steamid,
          games_owned,
          total_playtime_minutes,
          unplayed_games,
          unplayed_percentage,
          generated_at

        )


        SELECT

          $1,

          COUNT(*)::integer,

          COALESCE(
            SUM(
              playtime_forever_minutes
            ),
            0
          )::bigint,

          COUNT(*) FILTER (
            WHERE
              playtime_forever_minutes = 0
          )::integer,

          CASE

            WHEN COUNT(*) > 0

            THEN

              ROUND(
                (
                  COUNT(*) FILTER (
                    WHERE
                      playtime_forever_minutes = 0
                  )
                )::numeric

                /

                COUNT(*)::numeric

                *

                100,
                2
              )

            ELSE 0

          END,

          NOW()


        FROM steam_profile_games

        WHERE steamid = $1


        ON CONFLICT (steamid)

        DO UPDATE SET

          games_owned =
            EXCLUDED.games_owned,

          total_playtime_minutes =
            EXCLUDED.total_playtime_minutes,

          unplayed_games =
            EXCLUDED.unplayed_games,

          unplayed_percentage =
            EXCLUDED.unplayed_percentage,

          generated_at =
            EXCLUDED.generated_at


        RETURNING

          steamid,
          games_owned,
          total_playtime_minutes,
          unplayed_games,
          unplayed_percentage,
          generated_at
      `,
      [
        steamid
      ]
    );


  const row =
    result.rows[0];


  return {

    steamid:
      row.steamid,

    gamesOwned:
      Number(
        row.games_owned
      ),

    totalPlaytimeMinutes:
      Number(
        row.total_playtime_minutes
      ),

    unplayedGames:
      Number(
        row.unplayed_games
      ),

    unplayedPercentage:
      Number(
        row.unplayed_percentage
      ),

    generatedAt:
      row.generated_at
  };
}

export async function refreshProfileSpotlights() {

  /*
   * These are now extremely cheap queries.
   *
   * Each ORDER BY can use one of the indexes
   * we just created.
   */
  const result =
    await pool.query(
      `
        WITH largest_library AS (

          SELECT steamid

          FROM steam_profile_statistics

          ORDER BY
            games_owned DESC,
            steamid ASC

          LIMIT 1
        ),


        most_playtime AS (

          SELECT steamid

          FROM steam_profile_statistics

          WHERE steamid::bigint <> 76561197978088497

          ORDER BY
            total_playtime_minutes DESC,
            steamid ASC

          LIMIT 1
        ),


        highest_unplayed AS (

          SELECT steamid

          FROM steam_profile_statistics

          WHERE
            games_owned > 100

          ORDER BY
            unplayed_percentage DESC,
            games_owned DESC,
            steamid ASC

          LIMIT 1
        )


        INSERT INTO profile_spotlight_statistics (

          id,
          largest_library_steamid,
          most_playtime_steamid,
          highest_unplayed_steamid,
          generated_at

        )


        VALUES (

          1,

          (
            SELECT steamid
            FROM largest_library
          ),

          (
            SELECT steamid
            FROM most_playtime
          ),

          (
            SELECT steamid
            FROM highest_unplayed
          ),

          NOW()
        )


        ON CONFLICT (id)

        DO UPDATE SET

          largest_library_steamid =
            EXCLUDED.largest_library_steamid,

          most_playtime_steamid =
            EXCLUDED.most_playtime_steamid,

          highest_unplayed_steamid =
            EXCLUDED.highest_unplayed_steamid,

          generated_at =
            EXCLUDED.generated_at


        RETURNING

          largest_library_steamid,
          most_playtime_steamid,
          highest_unplayed_steamid,
          generated_at
      `
    );


  const row =
    result.rows[0];


  return {

    largestLibrarySteamId:
      row.largest_library_steamid,

    mostPlaytimeSteamId:
      row.most_playtime_steamid,

    highestUnplayedSteamId:
      row.highest_unplayed_steamid,

    generatedAt:
      row.generated_at
  };
}

export async function refreshProfileStatisticsBatch(
  steamids
) {

  if (
    !Array.isArray(
      steamids
    ) ||
    steamids.length === 0
  ) {

    return 0;
  }


  const result =
    await pool.query(
      `
        INSERT INTO steam_profile_statistics (

          steamid,
          games_owned,
          total_playtime_minutes,
          unplayed_games,
          unplayed_percentage,
          generated_at

        )


        SELECT

          p.steamid,

          COUNT(
            g.appid
          )::integer,

          COALESCE(
            SUM(
              g.playtime_forever_minutes
            ),
            0
          )::bigint,

          COUNT(
            g.appid
          ) FILTER (
            WHERE
              g.playtime_forever_minutes = 0
          )::integer,

          CASE

            WHEN
              COUNT(
                g.appid
              ) > 0

            THEN

              ROUND(
                (
                  COUNT(
                    g.appid
                  ) FILTER (
                    WHERE
                      g.playtime_forever_minutes = 0
                  )
                )::numeric

                /

                COUNT(
                  g.appid
                )::numeric

                *

                100,
                2
              )

            ELSE 0

          END,

          NOW()


        FROM steam_profiles p


        LEFT JOIN steam_profile_games g

          ON g.steamid =
             p.steamid


        WHERE

          p.steamid =
            ANY(
              $1::text[]
            )

          AND

          p.games_visible = TRUE

          AND

          p.playtime_available = TRUE


        GROUP BY
          p.steamid


        ON CONFLICT (steamid)

        DO UPDATE SET

          games_owned =
            EXCLUDED.games_owned,

          total_playtime_minutes =
            EXCLUDED.total_playtime_minutes,

          unplayed_games =
            EXCLUDED.unplayed_games,

          unplayed_percentage =
            EXCLUDED.unplayed_percentage,

          generated_at =
            EXCLUDED.generated_at
      `,
      [
        steamids
      ]
    );


  return result.rowCount;
}
import {
  pool,
  waitForDatabase
} from "./db.js";

import {
  refreshProfileStatisticsBatch,
  refreshProfileSpotlights
} from "./profileStatistics.js";

import {
  refreshDashboardStatistics
} from "./dashboardStatistics.js";


const BATCH_SIZE =
  500;


async function main() {

  try {

    await waitForDatabase();


    console.log(
      "Starting profile statistics backfill..."
    );


    /*
     * Remove any existing stats for profiles
     * that no longer qualify.
     */
    await pool.query(
      `
        DELETE FROM steam_profile_statistics s

        USING steam_profiles p

        WHERE

          s.steamid =
            p.steamid

          AND (

            p.games_visible
              IS DISTINCT FROM TRUE

            OR

            p.playtime_available
              IS DISTINCT FROM TRUE
          )
      `
    );


    let lastSteamId =
      "";


    let processed =
      0;


    while (true) {

      const result =
        await pool.query(
          `
            SELECT
              steamid

            FROM steam_profiles

            WHERE

              games_visible = TRUE

              AND

              playtime_available = TRUE

              AND

              steamid > $1

            ORDER BY
              steamid ASC

            LIMIT $2
          `,
          [
            lastSteamId,
            BATCH_SIZE
          ]
        );


      if (
        result.rows.length === 0
      ) {

        break;
      }


      const steamids =
        result.rows.map(
          row =>
            row.steamid
        );


      await refreshProfileStatisticsBatch(
        steamids
      );


      processed +=
        steamids.length;


      lastSteamId =
        steamids[
          steamids.length - 1
        ];


      console.log(
        `Profile statistics processed: ${processed}`
      );
    }


    console.log(
      "Refreshing dashboard statistics..."
    );


    await refreshDashboardStatistics();


    console.log(
      "Refreshing profile spotlights..."
    );


    await refreshProfileSpotlights();


    console.log(
      `Backfill complete. ${processed} profiles processed.`
    );


  } catch (error) {

    console.error(
      "Profile statistics backfill failed:",
      error
    );


    process.exitCode =
      1;


  } finally {

    await pool.end();
  }
}


main();
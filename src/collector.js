import { pool } from "./db.js";
import {
  getTopConcurrentGames,
  getAppName
} from "./steam.js";

let collectionRunning = false;

function sleep(milliseconds) {
  return new Promise((resolve) =>
    setTimeout(resolve, milliseconds)
  );
}

async function updateMissingGameNames(appids) {
  if (appids.length === 0) {
    return;
  }

/*   const placeholders = appids.map(() => "?").join(",");

  const [rows] = await pool.query(
    `
      SELECT appid
      FROM games
      WHERE appid IN (${placeholders})
        AND name IS NULL
    `,
    appids
  ); */


   /*
   * PostgreSQL lets us conveniently pass the whole
   * JavaScript array as a single parameter.
   */
  const result = await pool.query(
    `
      SELECT appid
      FROM games

      WHERE appid = ANY($1::bigint[])
        AND name IS NULL
    `,
    [appids]
  );

  const rows = result.rows;

  if (rows.length === 0) {
    return;
  }

  console.log(`Resolving ${rows.length} new game names...`);

  /*
   * Do a few lookups at a time instead of firing
   * 100 requests simultaneously.
   */
  const chunkSize = 5;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);

    await Promise.all(
      chunk.map(async ({ appid }) => {
        const name = await getAppName(appid);

        if (!name) {
          return;
        }
          await pool.query(
          `
            UPDATE games
            SET name = $1
            WHERE appid = $2
          `,
          [
            name,
            appid
          ]
        );

       /*  await pool.query(
          `
            UPDATE games
            SET name = ?
            WHERE appid = ?
          `,
          [name, appid]
        ); */

        console.log(`${appid}: ${name}`);
      })
    );

    /*
     * Be polite to Steam's store servers.
     */
    await sleep(250);
  }
}

export async function collectSnapshot() {
  if (collectionRunning) {
    console.log(
      "Collection already running. Skipping this scheduled run."
    );

    return;
  }

  collectionRunning = true;

  //let connection;
  let client;

  try {
    console.log(
      `Collecting Steam data at ${new Date().toISOString()}...`
    );

    const games = await getTopConcurrentGames();

    if (games.length === 0) {
      throw new Error("Steam returned zero games.");
    }

    const sampledAt = new Date();

    const totalConcurrentPlayers = games.reduce(
      (total, game) => total + game.currentPlayers,
      0
    );

    /*
     * Get a dedicated connection because we're
     * beginning a transaction.
     */
    client = await pool.connect();


    await client.query("BEGIN");


    /*
     * Insert/update game AppIDs.
     */
    for (const game of games) {

      await client.query(
        `
          INSERT INTO games (
            appid,
            first_seen_at,
            last_seen_at
          )

          VALUES (
            $1,
            $2,
            $3
          )

          ON CONFLICT (appid)

          DO UPDATE SET
            last_seen_at =
              EXCLUDED.last_seen_at
        `,
        [
          game.appid,
          sampledAt,
          sampledAt
        ]
      );
    }


    /*
     * PostgreSQL's RETURNING clause replaces
     * MySQL's insertId.
     */
    const snapshotResult =
      await client.query(
        `
          INSERT INTO snapshots (
            sampled_at,
            number_of_games,
            total_concurrent_players
          )

          VALUES (
            $1,
            $2,
            $3
          )

          RETURNING id
        `,
        [
          sampledAt,
          games.length,
          totalConcurrentPlayers
        ]
      );


    const snapshotId =
      snapshotResult.rows[0].id;


    /*
     * Generate:
     *
     * ($1,$2,$3,$4,$5),
     * ($6,$7,$8,$9,$10),
     * etc.
     */
    const values = [];

    const parameters = [];


    games.forEach((game, index) => {

      const offset = index * 5;

      values.push(
        `(
          $${offset + 1},
          $${offset + 2},
          $${offset + 3},
          $${offset + 4},
          $${offset + 5}
        )`
      );

      parameters.push(
        snapshotId,
        game.appid,
        game.rank,
        game.currentPlayers,
        game.peak24h
      );
    });


    await client.query(
      `
        INSERT INTO player_counts (
          snapshot_id,
          appid,
          ranking,
          current_players,
          peak_24h
        )

        VALUES

        ${values.join(",")}
      `,
      parameters
    );


    await client.query("COMMIT");

    // connection = await pool.getConnection();

    // await connection.beginTransaction();

    // /*
    //  * Make sure every AppID exists in the games table.
    //  */
    // for (const game of games) {
    //   await connection.query(
    //     `
    //       INSERT INTO games (
    //         appid,
    //         first_seen_at,
    //         last_seen_at
    //       )
    //       VALUES (?, ?, ?)

    //       ON DUPLICATE KEY UPDATE
    //         last_seen_at = VALUES(last_seen_at)
    //     `,
    //     [
    //       game.appid,
    //       sampledAt,
    //       sampledAt
    //     ]
    //   );
    // }

    // /*
    //  * Create the snapshot.
    //  */
    // const [snapshotResult] = await connection.query(
    //   `
    //     INSERT INTO snapshots (
    //       sampled_at,
    //       number_of_games,
    //       total_concurrent_players
    //     )
    //     VALUES (?, ?, ?)
    //   `,
    //   [
    //     sampledAt,
    //     games.length,
    //     totalConcurrentPlayers
    //   ]
    // );

    // const snapshotId = snapshotResult.insertId;

    // /*
    //  * Insert all 100 player-count records at once.
    //  */
    // const values = games.map((game) => [
    //   snapshotId,
    //   game.appid,
    //   game.rank,
    //   game.currentPlayers,
    //   game.peak24h
    // ]);

    // await connection.query(
    //   `
    //     INSERT INTO player_counts (
    //       snapshot_id,
    //       appid,
    //       ranking,
    //       current_players,
    //       peak_24h
    //     )
    //     VALUES ?
    //   `,
    //   [values]
    // );

    // await connection.commit();
    

    console.log(
      `Snapshot ${snapshotId}: ` +
      `${games.length} games, ` +
      `${totalConcurrentPlayers.toLocaleString()} players`
    );

    /*
     * Names aren't important enough to make the whole
     * snapshot fail, so resolve them after committing.
     */
    await updateMissingGameNames(
      games.map((game) => game.appid)
    );

    return {

      snapshotId,

      sampledAt,

      numberOfGames:
        games.length,

      totalConcurrentPlayers
    };

  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
        //connection.rollback();
      } catch {
        // Ignore rollback error.
      }
    }

    console.error("Steam collection failed:", error);
  } finally {
    if (client) {
      client.release();
    }

    collectionRunning = false;
  }
}
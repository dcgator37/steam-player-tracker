import { pool } from "./db.js";

import { config } from "./config.js";

import {
  getFriendList
} from "./steam.js";

function sleep(milliseconds) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        milliseconds
      )
  );
}

function validSteamId(steamid) {

  return /^\d{16,20}$/.test(
    String(steamid)
  );
}

export async function createFriendCrawl(
  seedSteamid,
  options = {}
) {

  seedSteamid =
    String(seedSteamid);

  if (!validSteamId(seedSteamid)) {

    throw new Error(
      "Invalid SteamID64."
    );
  }

  const maxDepth =
    Math.min(
      Math.max(
        Number(
          options.maxDepth ??
          config.friendCrawlDefaultDepth
        ),
        0
      ),
      10
    );

  const maxProfiles =
    Math.min(
      Math.max(
        Number(
          options.maxProfiles ??
          config.friendCrawlMaxProfiles
        ),
        1
      ),
      1000000
    );

  const client =
    await pool.connect();

  try {

    await client.query(
      "BEGIN"
    );

    const runResult =
      await client.query(
        `
          INSERT INTO friend_crawl_runs (
            seed_steamid,
            max_depth,
            max_profiles
          )

          VALUES (
            $1,
            $2,
            $3
          )

          RETURNING *
        `,
        [
          seedSteamid,
          maxDepth,
          maxProfiles
        ]
      );


    const run =
      runResult.rows[0];


    /*
     * Seed user starts at depth 0.
     *
     * If maxDepth is 0 we don't need to
     * expand their friend list.
     */
    await client.query(
      `
        INSERT INTO friend_crawl_queue (
          crawl_run_id,
          steamid,
          depth,
          source_steamid,
          status
        )

        VALUES (
          $1,
          $2,
          0,
          NULL,
          $3
        )
      `,
      [
        run.id,
        seedSteamid,

        maxDepth === 0
          ? "boundary"
          : "pending"
      ]
    );


    /*
     * Record how the seed entered
     * the dataset.
     */
    await client.query(
      `
        INSERT INTO steam_profile_discoveries (
          steamid,
          discovery_source,
          graph_depth
        )

        VALUES (
          $1,
          'friend_seed',
          0
        )

        ON CONFLICT DO NOTHING
      `,
      [
        seedSteamid
      ]
    );


    /*
     * Also queue the seed user's
     * owned-game profile for collection.
     */
    await client.query(
      `
        INSERT INTO steam_profile_queue (
          steamid
        )

        VALUES ($1)

        ON CONFLICT (steamid)
        DO NOTHING
      `,
      [
        seedSteamid
      ]
    );


    await client.query(
      "COMMIT"
    );


    return run;


  } catch (error) {

    await client.query(
      "ROLLBACK"
    );

    throw error;


  } finally {

    client.release();
  }
}

async function claimNextCrawlItem(runId) {

  const client = await pool.connect();

  try {

    await client.query(
      "BEGIN"
    );

    const result = await client.query(
        `
          SELECT
            crawl_run_id,
            steamid,
            depth,
            source_steamid

          FROM friend_crawl_queue

          WHERE crawl_run_id = $1
            AND status = 'pending'

          ORDER BY
            depth,
            enqueued_at

          LIMIT 1

          FOR UPDATE
          SKIP LOCKED
        `,
        [
          runId
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


    await client.query(
      `
        UPDATE friend_crawl_queue

        SET
          status = 'processing',

          attempts =
            attempts + 1,

          last_attempt_at =
            NOW()

        WHERE crawl_run_id = $1
          AND steamid = $2
      `,
      [
        runId,
        item.steamid
      ]
    );


    await client.query(
      "COMMIT"
    );


    return item;


  } catch (error) {

    await client.query(
      "ROLLBACK"
    );

    throw error;


  } finally {

    client.release();
  }
}

async function saveDiscoveredFriends(
  run,
  parentSteamid,
  parentDepth,
  friends
) {

  if (
    !Array.isArray(friends) ||
    friends.length === 0
  ) {

    return {
      newProfiles: 0,
      recordedRelationships: 0
    };
  }


  const childDepth = parentDepth + 1;


  const friendIds =
    [
      ...new Set(
        friends.map(
          friend =>
            String(
              friend.steamid
            )
        )
      )
    ];


  /*
   * Find which friends are already
   * part of this crawl.
   */
  const existingResult = await pool.query(
      `
        SELECT steamid

        FROM friend_crawl_queue

        WHERE crawl_run_id = $1

          AND steamid =
            ANY($2::text[])
      `,
      [
        run.id,
        friendIds
      ]
    );


  const existingIds = new Set(
      existingResult.rows.map(
        row => row.steamid
      )
    );


  const newIds =
    friendIds.filter(
      id =>
        !existingIds.has(id)
    );


  /*
   * Respect the per-crawl profile cap.
   */
  const countResult =
    await pool.query(
      `
        SELECT
          COUNT(*)::integer
            AS profile_count

        FROM friend_crawl_queue

        WHERE crawl_run_id = $1
      `,
      [
        run.id
      ]
    );

  const currentCount =
    countResult.rows[0]
      .profile_count;

  const remaining =
    Math.max(
      run.max_profiles -
      currentCount,
      0
    );

  const acceptedNewIds =
    newIds.slice(
      0,
      remaining
    );

  /*
   * Relationships to already-known users
   * are still useful, so preserve them.
   */
  const includedIds =
    new Set([
      ...existingIds,
      ...acceptedNewIds
    ]);

  const includedFriends =
    friends.filter(
      friend =>
        includedIds.has(
          String(friend.steamid)
        )
    );

  const client =
    await pool.connect();

  try {

    await client.query(
      "BEGIN"
    );

    /*
     * Add new users to this crawl.
     *
     * Users at maxDepth are marked
     * boundary immediately because their
     * friend lists do not need expanding.
     */
    if (
      acceptedNewIds.length > 0
    ) {

      const queueStatus =
        childDepth >=
        run.max_depth
          ? "boundary"
          : "pending";

      await client.query(
        `
          INSERT INTO friend_crawl_queue (
            crawl_run_id,
            steamid,
            depth,
            source_steamid,
            status
          )

          SELECT
            $1,
            new_steamid,
            $2,
            $3,
            $4

          FROM UNNEST(
            $5::text[]
          ) AS new_steamid

          ON CONFLICT (
            crawl_run_id,
            steamid
          )

          DO NOTHING
        `,
        [
          run.id,
          childDepth,
          parentSteamid,
          queueStatus,
          acceptedNewIds
        ]
      );

      /*
       * Every discovered SteamID also
       * becomes a candidate for your
       * existing owned-game collector.
       */
      await client.query(
        `
          INSERT INTO steam_profile_queue (
            steamid
          )

          SELECT new_steamid

          FROM UNNEST(
            $1::text[]
          ) AS new_steamid

          ON CONFLICT (steamid)
          DO NOTHING
        `,
        [
          acceptedNewIds
        ]
      );
    }


    /*
     * Store the discovery edges.
     *
     * A user can have multiple discovery
     * records if several friends lead to
     * the same person.
     */
    for (
      const friend
      of includedFriends
    ) {

      const friendSince =
        friend.friendSince > 0
          ? new Date(
              friend.friendSince *
              1000
            )
          : null;


      await client.query(
        `
          INSERT INTO
          steam_profile_discoveries (
            steamid,
            discovery_source,
            source_steamid,
            graph_depth,
            friend_since
          )

          VALUES (
            $1,
            'friend',
            $2,
            $3,
            $4
          )

          ON CONFLICT DO NOTHING
        `,
        [
          String(
            friend.steamid
          ),

          parentSteamid,

          childDepth,

          friendSince
        ]
      );
    }


    await client.query(
      "COMMIT"
    );


    return {

      newProfiles:
        acceptedNewIds.length,

      recordedRelationships:
        includedFriends.length
    };


  } catch (error) {

    await client.query(
      "ROLLBACK"
    );

    throw error;


  } finally {

    client.release();
  }
}

async function markExpanded(
  runId,
  steamid,
  friendsFound
) {

  await pool.query(
    `
      UPDATE friend_crawl_queue

      SET
        status =
          'expanded',

        friends_found =
          $3,

        processed_at =
          NOW(),

        error_message =
          NULL

      WHERE crawl_run_id = $1
        AND steamid = $2
    `,
    [
      runId,
      steamid,
      friendsFound
    ]
  );
}

async function markPrivate(
  runId,
  steamid
) {

  await pool.query(
    `
      UPDATE friend_crawl_queue

      SET
        status =
          'private',

        friends_found =
          NULL,

        processed_at =
          NOW(),

        error_message =
          NULL

      WHERE crawl_run_id = $1
        AND steamid = $2
    `,
    [
      runId,
      steamid
    ]
  );
}

async function markFailed(
  runId,
  steamid,
  message
) {

  await pool.query(
    `
      UPDATE friend_crawl_queue

      SET
        status =
          'failed',

        processed_at =
          NOW(),

        error_message =
          $3

      WHERE crawl_run_id = $1
        AND steamid = $2
    `,
    [
      runId,
      steamid,
      message
    ]
  );
}

async function returnToPending(
  runId,
  steamid,
  message
) {

  await pool.query(
    `
      UPDATE friend_crawl_queue

      SET
        status =
          'pending',

        error_message =
          $3

      WHERE crawl_run_id = $1
        AND steamid = $2
    `,
    [
      runId,
      steamid,
      message
    ]
  );
}

async function getRun(
  runId
) {

  const result =
    await pool.query(
      `
        SELECT *
        FROM friend_crawl_runs
        WHERE id = $1
      `,
      [
        runId
      ]
    );


  return (
    result.rows[0] ??
    null
  );
}

export async function getFriendCrawlStatus(
  runId
) {

  const run =
    await getRun(runId);


  if (!run) {

    return null;
  }


  const statsResult =
    await pool.query(
      `
        SELECT

          COUNT(*)::integer
            AS discovered_profiles,

          COUNT(*) FILTER (
            WHERE status = 'pending'
          )::integer
            AS pending,

          COUNT(*) FILTER (
            WHERE status = 'processing'
          )::integer
            AS processing,

          COUNT(*) FILTER (
            WHERE status = 'expanded'
          )::integer
            AS expanded,

          COUNT(*) FILTER (
            WHERE status = 'private'
          )::integer
            AS private_friend_lists,

          COUNT(*) FILTER (
            WHERE status = 'boundary'
          )::integer
            AS boundary_profiles,

          COUNT(*) FILTER (
            WHERE status = 'failed'
          )::integer
            AS failed

        FROM friend_crawl_queue

        WHERE crawl_run_id = $1
      `,
      [
        runId
      ]
    );


  return {

    ...run,

    stats:
      statsResult.rows[0]
  };
}

async function finalizeRunIfDone(
  runId
) {

  const result =
    await pool.query(
      `
        SELECT
          COUNT(*)::integer
            AS remaining

        FROM friend_crawl_queue

        WHERE crawl_run_id = $1

          AND status IN (
            'pending',
            'processing'
          )
      `,
      [
        runId
      ]
    );


  if (
    result.rows[0].remaining === 0
  ) {

    await pool.query(
      `
        UPDATE friend_crawl_runs

        SET
          status =
            'completed',

          completed_at =
            COALESCE(
              completed_at,
              NOW()
            )

        WHERE id = $1
      `,
      [
        runId
      ]
    );


    return true;
  }


  return false;
}

export async function processFriendCrawlBatch(
  runId,
  requestedLimit
) {

  const run =
    await getRun(runId);


  if (!run) {

    throw new Error(
      "Friend crawl run was not found."
    );
  }


  if (
    run.status ===
    "completed"
  ) {

    return getFriendCrawlStatus(
      runId
    );
  }


  const limit =
    Math.min(
      Math.max(
        Number(
          requestedLimit ??
          config.friendCrawlBatchSize
        ),
        1
      ),
      100
    );


  let processed = 0;


  while (
    processed < limit
  ) {

    const item =
      await claimNextCrawlItem(
        runId
      );


    if (!item) {
      break;
    }


    /*
     * This should normally never happen
     * because max-depth profiles get
     * boundary status when inserted.
     */
    if (
      item.depth >=
      run.max_depth
    ) {

      await pool.query(
        `
          UPDATE friend_crawl_queue

          SET
            status =
              'boundary',

            processed_at =
              NOW()

          WHERE crawl_run_id = $1
            AND steamid = $2
        `,
        [
          runId,
          item.steamid
        ]
      );


      processed++;

      continue;
    }


    try {

      console.log(
        `Friend crawl ${runId}: ` +
        `depth ${item.depth}, ` +
        `SteamID ${item.steamid}`
      );


      const result =
        await getFriendList(
          item.steamid
        );


      /*
       * Expected privacy case.
       */
      if (!result.accessible) {

        console.log(
          `Friend list private: ` +
          item.steamid
        );


        await markPrivate(
          runId,
          item.steamid
        );


        processed++;

        await sleep(
          config.friendCrawlDelayMs
        );

        continue;
      }


      const discovery =
        await saveDiscoveredFriends(
          run,
          item.steamid,
          item.depth,
          result.friends
        );


      await markExpanded(
        runId,
        item.steamid,
        result.friends.length
      );


      console.log(
        `Found ${result.friends.length} friends; ` +
        `${discovery.newProfiles} were new to this crawl.`
      );


    } catch (error) {

      if (
        error.code ===
        "STEAM_RATE_LIMIT"
      ) {

        await returnToPending(
          runId,
          item.steamid,
          error.message
        );


        console.warn(
          "Steam rate limit encountered. " +
          "Stopping this batch."
        );


        break;
      }


      console.error(
        `Friend lookup failed for ` +
        `${item.steamid}:`,
        error.message
      );


      await markFailed(
        runId,
        item.steamid,
        error.message
      );
    }


    processed++;


    await sleep(
      config.friendCrawlDelayMs
    );
  }


  await finalizeRunIfDone(
    runId
  );


  return getFriendCrawlStatus(
    runId
  );
}
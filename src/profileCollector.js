import { pool } from './db.js';
import { config } from './config.js';
import {
    getPlayerSummary,
    getOwnedGames
} from './steam.js';
import { refreshProfileSpotlights, refreshProfileStatistics } from './profileStatistics.js';

export async function collectProfile(steamid) {
  console.log(`Collecting Steam profile ${steamid}...`);

  const profile = await getPlayerSummary(steamid);

  if (!profile) {
    const error = new Error("Steam profile was not found.");
    error.code = "PROFILE_NOT_FOUND";
    throw error;
  }

  const ownedGames = await getOwnedGames(steamid);

  //cannot see game library at all
  if (!ownedGames.accessible) {
    console.log(
      `Game library for ${profile.personaname} is not publicly visible.`
    );

    await saveProfile(
      profile,
      ownedGames,
      [],
      {
        available: null,
        status: "game_details_private"
      }
    );

    return {
      steamid: profile.steamid,
      personaname: profile.personaname,
      gamesVisible: false,
      playtimeAvailable: null,
      gameCount: null
    };
  }
  
  //Determine whether Steam is actually returning usable playtime
  const playtimeStatus = analyzePlaytimeAvailability(
      ownedGames.games
    );


  const games = ownedGames.games.map(game => ({
    appid: Number(game.appid),

    name: game.name ?? null,

    playtimeForeverMinutes:
      Number(game.playtime_forever || 0),

    playtime2WeeksMinutes:
      game.playtime_2weeks == null
        ? null
        : Number(game.playtime_2weeks),

    playtimeWindowsMinutes:
      game.playtime_windows_forever == null
        ? null
        : Number(game.playtime_windows_forever),

    playtimeMacMinutes:
      game.playtime_mac_forever == null
        ? null
        : Number(game.playtime_mac_forever),

    playtimeLinuxMinutes:
      game.playtime_linux_forever == null
        ? null
        : Number(game.playtime_linux_forever),

    lastPlayedAt:
      game.rtime_last_played
        ? new Date(
            Number(game.rtime_last_played) * 1000
          )
        : null
  }));

  /*
   * Still save the game ownership information.
   *
   * It may be useful for other research even
   * if playtime is hidden.
   */
  await saveProfile(
    profile,
    ownedGames,
    games,
    playtimeStatus
  );

  await refreshProfileStatistics(steamid);
  await refreshProfileSpotlights(steamid);

    /*
   * IMPORTANT:
   *
   * Stop here rather than calculating
   * "400 unplayed games".
   */
  if (
    playtimeStatus.available === false
  ) {

    console.log(
      `Playtime unavailable for ` +
      `${profile.personaname}: ` +
      `${games.length} games all returned 0 minutes.`
    );


    return {

      steamid:
        profile.steamid,

      personaname:
        profile.personaname,

      gamesVisible:
        true,

      playtimeAvailable:
        false,

      playtimeStatus:
        playtimeStatus.status,

      gameCount:
        games.length
    };
  }

  const totalMinutes = games.reduce(
    (sum, game) =>
      sum + game.playtimeForeverMinutes,
    0
  );

  const neverPlayed = games.filter(
    game =>
      game.playtimeForeverMinutes === 0
  ).length;

  const underOneHour = games.filter(
    game =>
      game.playtimeForeverMinutes > 0 &&
      game.playtimeForeverMinutes < 60
  ).length;

  const underFiveHours = games.filter(
    game =>
      game.playtimeForeverMinutes > 0 &&
      game.playtimeForeverMinutes < 300
  ).length;

  return {
    steamid: profile.steamid,
    personaname: profile.personaname,
    gamesVisible: true,
    playtimeAvailable: playtimeStatus.available,
    gameCount: games.length,

    neverPlayed,

    neverPlayedPercentage:
      games.length > 0
        ? Number(
            (
              neverPlayed /
              games.length *
              100
            ).toFixed(1)
          )
        : 0,

    underOneHour,

    underFiveHours,

    totalHours:
      Number(
        (totalMinutes / 60).toFixed(1)
      )
  };
}

async function saveProfile(
  profile,
  ownedGames,
  enrichedGames,
  playtimeStatus
) {

  const client =
    await pool.connect();


  const collectedAt =
    new Date();


  try {

    await client.query("BEGIN");


    /*
     * Save/update profile.
     */
    await client.query(
      `
        INSERT INTO steam_profiles (
          steamid,
          personaname,
          profile_url,
          avatar_url,
          community_visibility_state,
          games_visible,
          reported_game_count,
          playtime_available,
          playtime_status,
          first_collected_at,
          last_collected_at
        )

        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $10
        )

        ON CONFLICT (steamid)

        DO UPDATE SET

          personaname =
            EXCLUDED.personaname,

          profile_url =
            EXCLUDED.profile_url,

          avatar_url =
            EXCLUDED.avatar_url,

          community_visibility_state =
            EXCLUDED.community_visibility_state,

          games_visible =
            EXCLUDED.games_visible,

          reported_game_count =
            EXCLUDED.reported_game_count,

          playtime_available =
            EXCLUDED.playtime_available,

          playtime_status =
            EXCLUDED.playtime_status,

          last_collected_at =
            EXCLUDED.last_collected_at
      `,
      [
        profile.steamid,

        profile.personaname ?? null,

        profile.profileurl ?? null,

        profile.avatarfull ?? null,

        profile.communityvisibilitystate ??
          null,

        ownedGames.accessible,

        ownedGames.gameCount,

        playtimeStatus.available,
        playtimeStatus.status,
        collectedAt
      ]
    );


    /*
     * If the library isn't visible,
     * stop here.
     *
     * We don't delete old data simply because
     * somebody temporarily changes privacy.
     */
    if (!ownedGames.accessible) {

      await client.query("COMMIT");

      return;
    }


    /*
     * Insert games in batches so this will
     * still work for very large libraries.
     */
    const batchSize = 250;


    for (
      let start = 0;
      start < enrichedGames.length;
      start += batchSize
    ) {

      const batch =
        enrichedGames.slice(
          start,
          start + batchSize
        );


      const valueGroups = [];

      const parameters = [];


      batch.forEach(
        (game, index) => {

          const offset =
            index * 11;


          valueGroups.push(
            `(
              $${offset + 1},
              $${offset + 2},
              $${offset + 3},
              $${offset + 4},
              $${offset + 5},
              $${offset + 6},
              $${offset + 7},
              $${offset + 8},
              $${offset + 9},
              $${offset + 10},
              $${offset + 11}
            )`
          );


          parameters.push(

            profile.steamid,

            game.appid,

            game.name,

            game.playtimeForeverMinutes,

            game.playtime2WeeksMinutes,

            game.playtimeWindowsMinutes,

            game.playtimeMacMinutes,

            game.playtimeLinuxMinutes,

            game.lastPlayedAt,

            game.hasCommunityVisibleStats,

            collectedAt
          );
        }
      );


      await client.query(
        `
          INSERT INTO steam_profile_games (
            steamid,
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
          )

          VALUES

          ${valueGroups.join(",")}

          ON CONFLICT (
            steamid,
            appid
          )

          DO UPDATE SET

            name =
              EXCLUDED.name,

            playtime_forever_minutes =
              EXCLUDED.playtime_forever_minutes,

            playtime_2weeks_minutes =
              EXCLUDED.playtime_2weeks_minutes,

            playtime_windows_forever_minutes =
              EXCLUDED.playtime_windows_forever_minutes,

            playtime_mac_forever_minutes =
              EXCLUDED.playtime_mac_forever_minutes,

            playtime_linux_forever_minutes =
              EXCLUDED.playtime_linux_forever_minutes,

            last_played_at =
              EXCLUDED.last_played_at,

            has_community_visible_stats =
              EXCLUDED.has_community_visible_stats,

            collected_at =
              EXCLUDED.collected_at
        `,
        parameters
      );
    }


    /*
     * Remove games that aren't in the user's
     * currently reported owned library anymore.
     */
    const appids =
      enrichedGames.map(
        game => game.appid
      );


    if (appids.length === 0) {

      await client.query(
        `
          DELETE FROM steam_profile_games
          WHERE steamid = $1
        `,
        [profile.steamid]
      );

    } else {

      await client.query(
        `
          DELETE FROM steam_profile_games

          WHERE steamid = $1

          AND NOT (
            appid =
            ANY($2::bigint[])
          )
        `,
        [
          profile.steamid,
          appids
        ]
      );
    }


    await client.query("COMMIT");


  } catch (error) {

    await client.query("ROLLBACK");

    throw error;

  } finally {

    client.release();
  }
}

function analyzePlaytimeAvailability(games) {

  if (!Array.isArray(games)) {

    return {
      available: false,
      status: "unknown"
    };
  }


  /*
   * An account with no owned games doesn't
   * prove playtime is hidden.
   */
  if (games.length === 0) {

    return {
      available: null,
      status: "no_games"
    };
  }


  const gamesWithPlaytime =
    games.filter(
      game =>
        Number(
          game.playtime_forever || 0
        ) > 0
    );


  /*
   * This is the suspicious case.
   *
   * Library is visible, but Steam reports
   * zero playtime for every single game.
   *
   * Treat the profile as unusable for
   * playtime analysis.
   */
  if (
    gamesWithPlaytime.length === 0
  ) {

    return {
      available: false,
      status: "all_zero"
    };
  }


  return {
    available: true,
    status: "available"
  };
}
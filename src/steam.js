import { config } from "./config.js";

const STEAM_API_BASE = "https://api.steampowered.com";

export async function getTopConcurrentGames() {
  const url = new URL(
    `${STEAM_API_BASE}/ISteamChartsService/GetGamesByConcurrentPlayers/v1/`
  );

  url.searchParams.set("key", config.steamApiKey);

  const response = await fetch(url, {
    headers: {
      "User-Agent": "steam-player-tracker/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Steam API request failed: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json();

  const ranks = data?.response?.ranks;

  if (!Array.isArray(ranks)) {
    console.error(JSON.stringify(data, null, 2));

    throw new Error(
      "Unexpected Steam response: response.ranks was not found."
    );
  }

  return ranks.slice(0, 100).map((game) => ({
    rank: Number(game.rank),
    appid: Number(game.appid),
    currentPlayers: Number(game.concurrent_in_game || 0),
    peak24h:
      game.peak_in_game !== undefined
        ? Number(game.peak_in_game)
        : null
  }));
}

export async function getAppName(appid) {
  const url = new URL(
    "https://store.steampowered.com/api/appdetails"
  );

  url.searchParams.set("appids", appid);
  url.searchParams.set("filters", "basic");
  url.searchParams.set("cc", "us");
  url.searchParams.set("l", "english");

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "steam-player-tracker/1.0"
      }
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    const game = data[String(appid)];
    
    if (!game?.success) {
      return null;
    }

    return game?.data?.name || null;
  } catch (error) {
    console.error(
      `Could not retrieve name for AppID ${appid}:`,
      error.message
    );

    return null;
  }
}

export async function getPlayerSummary(steamid) {
  const url = new URL(
    `${STEAM_API_BASE}/ISteamUser/GetPlayerSummaries/v2/`
  );

  url.searchParams.set("key", config.steamApiKey);
  url.searchParams.set("steamids", steamid);

  const response = await fetch(url, {
    headers: {
      "User-Agent": "steam-player-tracker/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(
      `GetPlayerSummaries failed: ` +
      `${response.status} ${response.statusText}`
    );
  }

  const data = await response.json();

  return (
    data?.response?.players?.[0] ??
    null
  );
}

export async function getOwnedGames(steamid) {

  const url = new URL(
    `${STEAM_API_BASE}/IPlayerService/GetOwnedGames/v1/`
  );

  url.searchParams.set(
    "key",
    config.steamApiKey
  );

  url.searchParams.set(
    "steamid",
    steamid
  );

  url.searchParams.set(
    "include_appinfo",
    "1"
  );

  /*
   * Important for your research:
   *
   * Don't automatically add played free-to-play
   * games to the library dataset.
   *
   * We're trying to get closer to the user's
   * actual owned library.
   */
  url.searchParams.set(
    "include_played_free_games",
    "0"
  );


  const response = await fetch(url, {
    headers: {
      "User-Agent": "steam-player-tracker/1.0"
    }
  });


  if (!response.ok) {

    throw new Error(
      `GetOwnedGames failed: ` +
      `${response.status} ${response.statusText}`
    );
  }


  const data = await response.json();

  const result =
    data?.response ?? {};


  /*
   * If game_count isn't present at all,
   * the user's game details generally aren't
   * available to us.
   *
   * Don't confuse this with game_count = 0.
   */
  const accessible =
    Object.prototype.hasOwnProperty.call(
      result,
      "game_count"
    );


  return {

    accessible,

    gameCount:
      result.game_count ?? null,

    games:
      Array.isArray(result.games)
        ? result.games
        : []
  };
}

export async function getFriendList(steamid) {
  const url = new URL(
    `${STEAM_API_BASE}/ISteamUser/GetFriendList/v1/`
  );

  url.searchParams.set(
    "key",
    config.steamApiKey
  );
  url.searchParams.set(
    "steamid",
    steamid
  );
  url.searchParams.set(
    "relationship",
    "friend"
  );

  const response = await fetch(url, {
    headers: {
      "User-Agent": "steam-player-tracker/1.0"
    }
  });

  /*
   * Steam documents 401 as the response
   * when the user's friend list is private.
   *
   * That is expected, not an application
   * failure.
   */
  if (response.status === 401) {

    return {
      accessible: false,
      friends: []
    };
  }


  if (response.status === 429) {

    const error =
      new Error(
        "Steam rate limit reached."
      );

    error.code =
      "STEAM_RATE_LIMIT";

    error.status =
      429;

    throw error;
  }


  if (!response.ok) {

    const error =
      new Error(
        `GetFriendList failed for ` +
        `${steamid}: ` +
        `${response.status} ` +
        `${response.statusText}`
      );

    error.status =
      response.status;

    throw error;
  }

  const data = await response.json();

  const rawFriends =
    data?.friendslist?.friends;

  const friends = Array.isArray(rawFriends)
    ? rawFriends.map((friend) => ({
        steamid: String(friend.steamid),
        relationship: friend.relationship ?? "friend",
        friendSince: Number(friend.friend_since || 0)
      }))
    : [];
  return {
    accessible: true,
    friends
  };
}
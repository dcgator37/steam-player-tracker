CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,

    created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

    last_seen_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

    expires_at TIMESTAMPTZ
        NOT NULL
);


CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires
ON admin_sessions(expires_at);

CREATE TABLE IF NOT EXISTS games (
    appid BIGINT PRIMARY KEY,

    name TEXT,

    first_seen_at TIMESTAMPTZ(3) NOT NULL,

    last_seen_at TIMESTAMPTZ(3) NOT NULL
);


CREATE TABLE IF NOT EXISTS snapshots (
    id BIGSERIAL PRIMARY KEY,

    sampled_at TIMESTAMPTZ(3) NOT NULL,

    number_of_games INTEGER NOT NULL,

    total_concurrent_players BIGINT NOT NULL
);


CREATE INDEX IF NOT EXISTS idx_snapshots_sampled_at
ON snapshots(sampled_at);


CREATE TABLE IF NOT EXISTS player_counts (
    snapshot_id BIGINT NOT NULL,

    appid BIGINT NOT NULL,

    ranking INTEGER NOT NULL,

    current_players BIGINT NOT NULL,

    peak_24h BIGINT,

    PRIMARY KEY(snapshot_id, appid),

    CONSTRAINT fk_player_counts_snapshot
        FOREIGN KEY(snapshot_id)
        REFERENCES snapshots(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_player_counts_game
        FOREIGN KEY(appid)
        REFERENCES games(appid)
);


CREATE INDEX IF NOT EXISTS idx_player_counts_appid
ON player_counts(appid);


CREATE INDEX IF NOT EXISTS idx_player_counts_ranking
ON player_counts(ranking);


CREATE TABLE IF NOT EXISTS steam_profiles (
    steamid TEXT PRIMARY KEY,

    personaname TEXT,

    profile_url TEXT,

    avatar_url TEXT,

    community_visibility_state INTEGER,

    games_visible BOOLEAN NOT NULL DEFAULT FALSE,

    reported_game_count INTEGER,

    first_collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    last_collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE TABLE IF NOT EXISTS steam_profile_games (
    steamid TEXT NOT NULL,

    appid BIGINT NOT NULL,

    name TEXT,

    playtime_forever_minutes INTEGER NOT NULL DEFAULT 0,

    playtime_2weeks_minutes INTEGER,

    playtime_windows_forever_minutes INTEGER,

    playtime_mac_forever_minutes INTEGER,

    playtime_linux_forever_minutes INTEGER,

    last_played_at TIMESTAMPTZ,

    has_community_visible_stats BOOLEAN,

    collected_at TIMESTAMPTZ NOT NULL,

    PRIMARY KEY (steamid, appid),

    CONSTRAINT fk_profile_games_profile
        FOREIGN KEY (steamid)
        REFERENCES steam_profiles(steamid)
        ON DELETE CASCADE
);


CREATE INDEX IF NOT EXISTS idx_profile_games_appid
ON steam_profile_games(appid);


CREATE INDEX IF NOT EXISTS idx_profile_games_playtime
ON steam_profile_games(playtime_forever_minutes);


CREATE INDEX IF NOT EXISTS idx_profile_games_steamid_playtime
ON steam_profile_games(
    steamid,
    playtime_forever_minutes
);

CREATE INDEX IF NOT EXISTS
idx_steam_profiles_usable_playtime
ON steam_profiles(steamid)
WHERE
    games_visible = TRUE
    AND playtime_available = TRUE;

CREATE TABLE IF NOT EXISTS steam_profile_queue (
    steamid TEXT PRIMARY KEY,

    status TEXT NOT NULL DEFAULT 'pending',

    attempts INTEGER NOT NULL DEFAULT 0,

    discovered_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

    last_attempt_at TIMESTAMPTZ,

    completed_at TIMESTAMPTZ,

    error_message TEXT,

    CONSTRAINT chk_profile_queue_status
        CHECK (
            status IN (
                'pending',
                'processing',
                'completed',
                'game_details_private',
                'not_found',
                'failed'
            )
        )
);


CREATE TABLE IF NOT EXISTS steam_profile_discoveries (
    id BIGSERIAL PRIMARY KEY,

    steamid TEXT NOT NULL,

    discovery_source TEXT NOT NULL,

    source_steamid TEXT,

    source_appid BIGINT,

    graph_depth INTEGER,

    friend_since TIMESTAMPTZ,

    discovered_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
);


CREATE UNIQUE INDEX IF NOT EXISTS
idx_unique_profile_discovery

ON steam_profile_discoveries (
    steamid,
    discovery_source,
    COALESCE(source_steamid, ''),
    COALESCE(source_appid, 0),
    COALESCE(graph_depth, -1)
);


CREATE INDEX IF NOT EXISTS
idx_profile_discovery_steamid

ON steam_profile_discoveries(steamid);


CREATE TABLE IF NOT EXISTS friend_crawl_runs (
    id BIGSERIAL PRIMARY KEY,

    seed_steamid TEXT NOT NULL,

    max_depth INTEGER NOT NULL,

    max_profiles INTEGER NOT NULL,

    status TEXT NOT NULL DEFAULT 'running',

    started_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

    completed_at TIMESTAMPTZ,

    CONSTRAINT chk_friend_crawl_status
        CHECK (
            status IN (
                'running',
                'completed',
                'failed'
            )
        )
);


CREATE TABLE IF NOT EXISTS friend_crawl_queue (
    crawl_run_id BIGINT NOT NULL,

    steamid TEXT NOT NULL,

    depth INTEGER NOT NULL,

    source_steamid TEXT,

    status TEXT NOT NULL DEFAULT 'pending',

    attempts INTEGER NOT NULL DEFAULT 0,

    friends_found INTEGER,

    enqueued_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

    last_attempt_at TIMESTAMPTZ,

    processed_at TIMESTAMPTZ,

    error_message TEXT,

    PRIMARY KEY (
        crawl_run_id,
        steamid
    ),

    CONSTRAINT fk_friend_crawl_run
        FOREIGN KEY(crawl_run_id)
        REFERENCES friend_crawl_runs(id)
        ON DELETE CASCADE,

    CONSTRAINT chk_friend_queue_status
        CHECK (
            status IN (
                'pending',
                'processing',
                'expanded',
                'private',
                'boundary',
                'failed'
            )
        )
);


CREATE INDEX IF NOT EXISTS
idx_friend_crawl_queue_pending

ON friend_crawl_queue(
    crawl_run_id,
    status,
    depth
);

ALTER TABLE steam_profile_queue

ADD COLUMN IF NOT EXISTS next_attempt_at
    TIMESTAMPTZ NOT NULL DEFAULT NOW();

/* ALTER TABLE steam_profile_queue

DROP CONSTRAINT IF EXISTS
chk_profile_queue_status;

ALTER TABLE steam_profile_queue

ADD CONSTRAINT chk_profile_queue_status 

CHECK (
    status IN (
        'pending',
        'processing',
        'completed',
        'game_details_private',
        'playtime_unavailable',
        'not_found',
        'failed'
    )
);
*/

ALTER TABLE steam_profiles
ADD COLUMN IF NOT EXISTS playtime_available BOOLEAN;

ALTER TABLE steam_profiles
ADD COLUMN IF NOT EXISTS playtime_status TEXT;


CREATE INDEX IF NOT EXISTS
idx_steam_profile_queue_work

ON steam_profile_queue (
    status,
    next_attempt_at,
    discovered_at
);

/* CREATE DATABASE IF NOT EXISTS steam_tracker;
USE steam_tracker; */

/* CREATE TABLE IF NOT EXISTS games (
    appid BIGINT UNSIGNED PRIMARY KEY,
    name VARCHAR(255) NULL,
    first_seen_at DATETIME(3) NOT NULL,
    last_seen_at DATETIME(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    sampled_at DATETIME(3) NOT NULL,
    number_of_games INT UNSIGNED NOT NULL,
    total_concurrent_players BIGINT UNSIGNED NOT NULL,

    INDEX idx_snapshots_sampled_at (sampled_at)
);

CREATE TABLE IF NOT EXISTS player_counts (
    snapshot_id BIGINT UNSIGNED NOT NULL,
    appid BIGINT UNSIGNED NOT NULL,
    ranking INT UNSIGNED NOT NULL,
    current_players BIGINT UNSIGNED NOT NULL,
    peak_24h BIGINT UNSIGNED NULL,

    PRIMARY KEY (snapshot_id, appid),

    INDEX idx_player_counts_appid (appid),
    INDEX idx_player_counts_ranking (ranking),

    CONSTRAINT fk_player_counts_snapshot
        FOREIGN KEY (snapshot_id)
        REFERENCES snapshots(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_player_counts_game
        FOREIGN KEY (appid)
        REFERENCES games(appid)
); */
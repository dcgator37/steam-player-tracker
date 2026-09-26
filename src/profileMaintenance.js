import { pool } from "./db.js";

export async function backfillPlaytimeAvailability() {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        //get some before-counts so the endpoint can report on what will be updated
        const beforeResult = await client.query(
            `
                SELECT
                    COUNT(*)::integer AS total_missing,

                    COUNT(*) FILTER (
                        WHERE games_visible = true
                    )::integer AS visible_games_profiles,

                    COUNT(*) FILTER (
                        WHERE games_visible = false
                    )::integer AS hidden_games_profiles

                FROM steam_profiles
                WHERE playtime_available IS NULL
                    AND playtime_status IS NULL
            `
        
        );

        /*
            determine playtime status using stored games for each profile
        */

        const updateResult = await client.query(
            `
                WITH profile_playtime AS (
                    SELECT p.steamid,
                            p.games_visible,
                        COUNT(g.appid)::integer AS stored_game_count,
                        COUNT(*) FILTER (
                            WHERE g.playtime_forever_minutes > 0
                        )::integer AS played_game_count,
                        COALESCE(
                            SUM(g.playtime_forever_minutes),
                            0
                        ) AS total_playtime_minutes
                    FROM steam_profiles p
                    LEFT JOIN steam_profile_games g
                        ON p.steamid = g.steamid
                    WHERE p.playtime_available IS NULL
                        AND p.playtime_status IS NULL
                    GROUP BY p.steamid, p.games_visible
                )

                UPDATE steam_profiles p
                SET playtime_available =
                    CASE
                        WHEN pp.games_visible = false THEN false
                        WHEN pp.stored_game_count = 0 THEN false
                        WHEN pp.played_game_count > 0 THEN true
                        ELSE false
                    END,
                playtime_status = 
                    CASE
                        WHEN pp.games_visible = false THEN 'game_details_private'
                        WHEN pp.stored_game_count = 0 THEN 'no_games'
                        WHEN pp.played_game_count > 0 THEN 'available'
                        ELSE 'all zero'
                    END
                FROM profile_playtime pp
                WHERE p.steamid = pp.steamid

                RETURNING p.steamid, p.personaname, p.games_visible, p.reported_game_count,
                p.playtime_available, p.playtime_status
            `
        );

        //need to update previously complete profiles in the queue as hidden/unavailable playtime
        const queueUpdateResult = await client.query(
            `
                UPDATE steam_profile_queue q
                SET status = 'playtime_unavailable',
                completed_at = 
                    COALESCE(
                        completed_at,
                        NOW()
                    ),
                    error_message = null
                FROM steam_profiles p
                WHERE q.steamid = p.steamid
                    AND p.playtime_available = false
                    AND p.playtime_status  = 'all_zero'
                    AND q.status = 'completed'
                RETURNING q.steamid
            `
        );

        await client.query("COMMIT");

        const updatedProfiles = updateResult.rows;


        const summary = {
            originallyMissing: beforeResult.rows[0].total_missing,
            updated: updatedProfiles.length,
            available: updatedProfiles.filter(
                profile => profile.playtime_status === 'available'
            ).length,
            allZero: updatedProfiles.filter(
                profile => profile.playtime_status === 'all_zero'
            ).length,
            noGames: updatedProfiles.filter(
                profile => profile.playtime_status === 'no_games'
            ).length,
            gameDetailsPrivate: updatedProfiles.filter(
                profile => profile.playtime_status === 'game_details_private'
            ).length,
            queueUpdated: queueUpdateResult.rows.length
        };

        return {
            summary,
            profiles: updatedProfiles
        }

    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}
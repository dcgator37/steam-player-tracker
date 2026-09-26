import { pool, waitForDatabase } from "./db.js"
import { collectSnapshot } from "./collector.js"

async function main() {
    const startedAt = new Date();

    console.log("=========================");
    console.log("Steam snapshot collector");
    console.log(`Started: ${startedAt.toISOString()}`);
    console.log("=========================");

    try {
        await waitForDatabase();

        const result = await collectSnapshot();

        console.log("Collection successful");
        console.log({
            snapshotId:
                result.snapshotId,

            sampledAt:
                result.sampledAt,

            games:
                result.numberOfGames,

            players:
                result.totalConcurrentPlayers
        });
    } catch (error) {
        console.error("Steam collection FAILED:");

        console.error(error);

        process.exitCode = 1;
    } finally {
        try {
            await pool.end();
        } catch (error) {
            console.error("Error closing PostgreSQL pool:",error);
            process.exitCode = 1;
        }
        console.log(`Finished: ${new Date().toISOString()}`);

    }
}

main();
import {
  pool,
  waitForDatabase
} from "./db.js";

import {
  refreshDashboardStatistics
} from "./dashboardStatistics.js";


async function main() {

  try {

    await waitForDatabase();


    console.log(
      "Refreshing dashboard statistics..."
    );


    const result =
      await refreshDashboardStatistics();


    console.log(
      "Dashboard statistics updated:"
    );


    console.log(result);


  } catch (error) {

    console.error(
      "Dashboard statistics refresh failed:",
      error
    );


    process.exitCode = 1;


  } finally {

    await pool.end();
  }
}


main();
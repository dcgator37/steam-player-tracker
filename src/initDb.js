import fs from "fs/promises";

import { pool } from "./db.js";


async function initializeDatabase() {

  try {

    const sql =
      await fs.readFile(
        "./sql/init.sql",
        "utf8"
      );


    console.log(
      "Initializing PostgreSQL database..."
    );


    await pool.query(sql);


    console.log(
      "Database initialization complete."
    );

  } catch (error) {

    console.error(
      "Database initialization failed:",
      error
    );

    process.exitCode = 1;

  } finally {

    await pool.end();
  }
}


initializeDatabase();
//import mysql from "mysql2/promise";
import pg from "pg";
import { config } from "./config.js";

const { Pool, types } = pg;

/*
 * PostgreSQL returns BIGINT values as strings by default.
 *
 * Steam counts and our database IDs are safely within
 * JavaScript's integer range for this application, so
 * convert PostgreSQL BIGINT values to JavaScript numbers.
 */
types.setTypeParser(20, (value) => Number(value));

export const pool = new Pool({
  connectionString: config.databaseUrl,

  max: 10,

  idleTimeoutMillis: 30000,

  connectionTimeoutMillis: 10000
});

pool.on("error", (error) => {
  console.error(
    "Unexpected PostgreSQL pool error:",
    error
  );
});

export async function waitForDatabase() {
  const attempts = 30;

  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query("SELECT 1");

      console.log("Connected to PostgreSQL.");

      return;
    } catch (error) {
      console.log(
        `Waiting for PostgreSQL (${i}/${attempts})... ${error.message}`
      );

      await new Promise((resolve) =>
        setTimeout(resolve, 2000)
      );
    }
  }

  throw new Error(
    "Could not connect to PostgreSQL."
  );
}

/* export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,

  timezone: "Z"
});

export async function waitForDatabase() {
  const attempts = 30;

  for (let i = 1; i <= attempts; i++) {
    try {
      const connection = await pool.getConnection();

      await connection.query("SELECT 1");

      connection.release();

      console.log("Connected to MySQL.");

      return;
    } catch (error) {
      console.log(
        `Waiting for MySQL (${i}/${attempts})... ${error.message}`
      );

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  throw new Error("Could not connect to MySQL.");
} */
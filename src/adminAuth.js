import {
  pool
} from "./db.js";

import {
  config
} from "./config.js";

import {
  createSessionToken,
  hashSessionToken
} from "./authCrypto.js";


export const ADMIN_COOKIE_NAME =
  "steam_admin_session";


function getCookie(
  req,
  name
) {

  const header =
    req.headers.cookie;


  if (!header) {

    return null;
  }


  for (
    const entry
    of header.split(";")
  ) {

    const [
      key,
      ...valueParts
    ] =
      entry
        .trim()
        .split("=");


    if (
      key === name
    ) {

      return decodeURIComponent(
        valueParts.join("=")
      );
    }
  }


  return null;
}


function getCookieOptions() {

  return {

    httpOnly:
      true,

    secure:
      config.adminCookieSecure,

    sameSite:
      config.adminCookieSameSite,

    path:
      "/"
  };
}


export async function createAdminSession(
  res
) {

  /*
   * Housekeeping.
   */
  await pool.query(
    `
      DELETE FROM admin_sessions
      WHERE expires_at <= NOW()
    `
  );


  const token =
    createSessionToken();


  const tokenHash =
    hashSessionToken(
      token
    );


  const expiresAt =
    new Date(

      Date.now() +

      (
        config.adminSessionHours *
        60 *
        60 *
        1000
      )
    );


  await pool.query(
    `
      INSERT INTO admin_sessions (
        token_hash,
        expires_at
      )

      VALUES (
        $1,
        $2
      )
    `,
    [
      tokenHash,
      expiresAt
    ]
  );


  res.cookie(
    ADMIN_COOKIE_NAME,
    token,
    {
      ...getCookieOptions(),

      maxAge:
        config.adminSessionHours *
        60 *
        60 *
        1000
    }
  );


  return {
    expiresAt
  };
}


export async function getAdminSession(
  req
) {

  const token =
    getCookie(
      req,
      ADMIN_COOKIE_NAME
    );


  if (!token) {

    return null;
  }


  const tokenHash =
    hashSessionToken(
      token
    );


  const result =
    await pool.query(
      `
        SELECT
          token_hash,
          created_at,
          last_seen_at,
          expires_at

        FROM admin_sessions

        WHERE
          token_hash = $1

          AND
          expires_at > NOW()
      `,
      [
        tokenHash
      ]
    );


  if (
    result.rows.length === 0
  ) {

    return null;
  }


  await pool.query(
    `
      UPDATE admin_sessions

      SET last_seen_at = NOW()

      WHERE token_hash = $1
    `,
    [
      tokenHash
    ]
  );


  return result.rows[0];
}


export async function destroyAdminSession(
  req,
  res
) {

  const token =
    getCookie(
      req,
      ADMIN_COOKIE_NAME
    );


  if (token) {

    const tokenHash =
      hashSessionToken(
        token
      );


    await pool.query(
      `
        DELETE FROM admin_sessions
        WHERE token_hash = $1
      `,
      [
        tokenHash
      ]
    );
  }


  res.clearCookie(
    ADMIN_COOKIE_NAME,
    getCookieOptions()
  );
}


export async function requireAdmin(
  req,
  res,
  next
) {

  try {

    const session =
      await getAdminSession(
        req
      );


    if (!session) {

      return res
        .status(401)
        .json({
          error:
            "Administrator authentication required."
        });
    }


    req.adminSession =
      session;


    next();


  } catch (error) {

    next(error);
  }
}


export function requireTrustedOrigin(
  req,
  res,
  next
) {

  const origin =
    req.get("origin");


  /*
   * Non-browser tools such as curl/Postman
   * may not send Origin. Browser cross-site
   * requests do.
   */
  if (!origin) {

    return next();
  }


  let allowedOrigin;


  try {

    allowedOrigin =
      new URL(
        config.frontendUrl
      ).origin;

  } catch {

    return res
      .status(500)
      .json({
        error:
          "FRONTEND_URL is invalid."
      });
  }


  if (
    origin !== allowedOrigin
  ) {

    return res
      .status(403)
      .json({
        error:
          "Request origin is not allowed."
      });
  }


  next();
}
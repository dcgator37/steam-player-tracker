import express from "express";

import {
  config
} from "./config.js";

import {
  verifyPasswordHash
} from "./authCrypto.js";

import {
  createAdminSession,
  destroyAdminSession,
  getAdminSession,
  requireTrustedOrigin
} from "./adminAuth.js";


const router =
  express.Router();


router.post(
  "/login",

  requireTrustedOrigin,

  async (
    req,
    res
  ) => {

    try {

      if (
        !config.adminPasswordHash
      ) {

        return res
          .status(503)
          .json({
            error:
              "Administrator authentication is not configured."
          });
      }


      const password =
        req.body?.password;


      if (
        typeof password !== "string" ||
        password.length === 0 ||
        password.length > 256
      ) {

        return res
          .status(400)
          .json({
            error:
              "A password is required."
          });
      }

      console.log(
  "Admin login request:",
  {
    origin:
      req.get("origin"),

    hasPassword:
      typeof req.body?.password ===
      "string",

    passwordLength:
      req.body?.password?.length,

    hasConfiguredHash:
      Boolean(
        config.adminPasswordHash
      ),

    hashParts:
      config.adminPasswordHash
        ?.split("$")
        .length
  }
);

      const valid =
        await verifyPasswordHash(
          password,
          config.adminPasswordHash
        );


      if (!valid) {

        /*
         * Keep the response generic.
         */
        return res
          .status(401)
          .json({
            error:
              "Invalid administrator credentials."
          });
      }


      const session =
        await createAdminSession(
          res
        );


      res.json({

        authenticated:
          true,

        expiresAt:
          session.expiresAt
      });


    } catch (error) {

      console.error(
        "Admin login failed:",
        error
      );


      res
        .status(500)
        .json({
          error:
            "Could not create administrator session."
        });
    }
  }
);


router.get(
  "/session",

  async (
    req,
    res
  ) => {

    try {

      const session =
        await getAdminSession(
          req
        );


      if (!session) {

        return res.json({

          authenticated:
            false
        });
      }


      res.json({

        authenticated:
          true,

        expiresAt:
          session.expires_at
      });


    } catch (error) {

      console.error(
        "Admin session check failed:",
        error
      );


      res
        .status(500)
        .json({
          error:
            "Could not check administrator session."
        });
    }
  }
);


router.post(
  "/logout",

  requireTrustedOrigin,

  async (
    req,
    res
  ) => {

    try {

      await destroyAdminSession(
        req,
        res
      );


      res.json({

        authenticated:
          false
      });


    } catch (error) {

      console.error(
        "Admin logout failed:",
        error
      );


      res
        .status(500)
        .json({
          error:
            "Could not end administrator session."
        });
    }
  }
);


export default router;
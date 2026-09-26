import express from "express";

import {
  createFriendCrawl,
  processFriendCrawlBatch,
  getFriendCrawlStatus
} from "./friendCrawler.js";


const router =
  express.Router();


function validSteamId(steamid) {

  return /^\d{16,20}$/.test(
    String(steamid)
  );
}

router.post("/friends/:steamid/start", async (req, res) => {

    const steamid =
      String(
        req.params.steamid
      );

    if (!validSteamId(steamid)) {

      return res
        .status(400)
        .json({
          error:
            "Invalid SteamID64."
        });
    }

    try {

      const run = await createFriendCrawl(
          steamid,
          {
            maxDepth:
              req.body?.maxDepth,

            maxProfiles:
              req.body?.maxProfiles
          }
        );


      res.status(201).json({
        message:
          "Friend crawl created.",

        run
      });


    } catch (error) {

      console.error(error);


      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

router.post("/friends/runs/:runId/process", async (req, res) => {

    const runId =
      Number(
        req.params.runId
      );


    if (
      !Number.isInteger(runId)
    ) {

      return res
        .status(400)
        .json({
          error:
            "Invalid crawl run ID."
        });
    }


    try {

      const result =
        await processFriendCrawlBatch(
          runId,
          req.body?.limit
        );


      res.json(
        result
      );


    } catch (error) {

      console.error(error);


      if (
        error.code ===
        "STEAM_RATE_LIMIT"
      ) {

        return res
          .status(429)
          .json({
            error:
              error.message
          });
      }


      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

router.get("/friends/runs/:runId", async (req, res) => {

    const runId =
      Number(
        req.params.runId
      );


    try {

      const result =
        await getFriendCrawlStatus(
          runId
        );


      if (!result) {

        return res
          .status(404)
          .json({
            error:
              "Friend crawl not found."
          });
      }


      res.json(
        result
      );


    } catch (error) {

      console.error(error);


      res.status(500).json({
        error:
          "Could not retrieve crawl."
      });
    }
  }
);


export default router;
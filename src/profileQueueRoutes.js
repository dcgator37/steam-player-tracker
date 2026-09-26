import express from "express";

import {
  processProfileQueue,
  getProfileQueueStatus
} from "./profileQueueWorker.js";

import { requireAdmin, requireTrustedOrigin } from "./adminAuth.js";


const router =
  express.Router();

router.post("/process", requireTrustedOrigin, async (req, res) => {

    try {

      const result =
        await processProfileQueue({
          limit:
            req.body?.limit,

          concurrency:
            req.body?.concurrency
        });


      res.json(
        result
      );


    } catch (error) {

      console.error(
        "Profile queue processing failed:",
        error
      );


      res.status(500).json({
        error:
          "Profile queue processing failed.",

        message:
          error.message
      });
    }
  }
);

router.get("/status", requireAdmin, async (req, res) => {

    try {

      const result =
        await getProfileQueueStatus();


      res.json(
        result
      );


    } catch (error) {

      console.error(
        error
      );


      res.status(500).json({
        error:
          "Could not retrieve profile queue status."
      });
    }
  }
);


export default router;
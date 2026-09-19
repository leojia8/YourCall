import express from "express";
import { env } from "./config/env";
import { linqRouter } from "./linq/linq.routes";

const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use(linqRouter);

app.listen(env.PORT, () => {
  console.log(`Server listening on port ${env.PORT}`);
});

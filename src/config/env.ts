import "dotenv/config";

// Central place for environment variables. Each layer adds its own section.
export const env = {
  PORT: Number(process.env.PORT ?? 3000),

  // --- Linq (Person 1) ---
  LINQ_API_KEY: process.env.LINQ_API_KEY ?? "",
  // `||` (not `??`) so an empty `LINQ_BASE_URL=` in .env still gets the default.
  LINQ_BASE_URL: process.env.LINQ_BASE_URL || "https://api.linqapp.com/api/partner/v3",
  // whsec_... returned ONCE when the webhook subscription is created.
  LINQ_WEBHOOK_SECRET: process.env.LINQ_WEBHOOK_SECRET ?? "",
  // Our Linq number in E.164 (e.g. +16462049058). Only needed to message someone first.
  LINQ_FROM_NUMBER: process.env.LINQ_FROM_NUMBER ?? "",
};

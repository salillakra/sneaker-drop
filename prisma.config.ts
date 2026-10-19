import "./lib/env";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Client generation during install needs no database; migrations require it.
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  },
});

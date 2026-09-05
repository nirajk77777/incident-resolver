import { pgSchema } from "drizzle-orm/pg-core";

/**
 * One Postgres instance, three schemas. Tables are added by the issues that own them:
 * ShopLite's own migrations fill `shoplite`, portal-api fills `portal`, mcp-incidents fills `knowledge`.
 */
export const shoplite = pgSchema("shoplite");
export const portal = pgSchema("portal");
export const knowledge = pgSchema("knowledge");

-- Sentinel's key for a problem: the route and the kind of error it saw. At most one open
-- Ticket per fingerprint, so a second detection of the same spike finds the Ticket already
-- open rather than filing another. Closed Tickets are outside the index, so the same problem
-- returning after it was closed opens a new Ticket, which is what it should do.
ALTER TABLE "portal"."tickets" ADD COLUMN "fingerprint" text;--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_open_fingerprint_idx" ON "portal"."tickets" USING btree ("fingerprint") WHERE "portal"."tickets"."status" <> 'closed';
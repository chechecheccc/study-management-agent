ALTER TABLE "tasks" ADD COLUMN "resource_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "images" jsonb DEFAULT '[]'::jsonb NOT NULL;
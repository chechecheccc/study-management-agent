CREATE TABLE "deletions" (
	"user_id" text NOT NULL,
	"entity" text NOT NULL,
	"record_id" text NOT NULL,
	"deleted_at" text NOT NULL,
	CONSTRAINT "deletions_user_id_entity_record_id_pk" PRIMARY KEY("user_id","entity","record_id")
);
--> statement-breakpoint
CREATE INDEX "deletions_user_idx" ON "deletions" USING btree ("user_id");
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text DEFAULT '新对话' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text
);
--> statement-breakpoint
CREATE TABLE "courses" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"semester" text DEFAULT '' NOT NULL,
	"color" text DEFAULT 'coral' NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"steps" jsonb,
	"images" jsonb,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"study_time" text DEFAULT '' NOT NULL,
	"goal" text DEFAULT '' NOT NULL,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"course_id" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"type" text DEFAULT '其他' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT '未整理' NOT NULL,
	"imported_at" text DEFAULT '' NOT NULL,
	"file_name" text,
	"file_key" text,
	"file_size" integer,
	"mime_type" text,
	"content_text" text,
	"updated_at" text NOT NULL,
	"deleted_at" text
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"course_id" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"type" text DEFAULT 'DDL' NOT NULL,
	"due_at" text DEFAULT '' NOT NULL,
	"status" text DEFAULT '未开始' NOT NULL,
	"priority" text DEFAULT '中' NOT NULL,
	"reminder" text DEFAULT '' NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"salt" text NOT NULL,
	"hash" text NOT NULL,
	"iterations" integer NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_user_updated_idx" ON "conversations" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "courses_user_updated_idx" ON "courses" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_user_idx" ON "messages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "resources_user_updated_idx" ON "resources" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "resources_content_idx" ON "resources" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tasks_user_due_idx" ON "tasks" USING btree ("user_id","due_at");
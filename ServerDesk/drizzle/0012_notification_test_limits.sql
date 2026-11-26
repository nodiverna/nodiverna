CREATE TABLE "notification_test_limits" (
	"principal" text PRIMARY KEY NOT NULL,
	"attempts" integer NOT NULL,
	"window_at" bigint NOT NULL
);

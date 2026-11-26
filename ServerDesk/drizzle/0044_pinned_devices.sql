CREATE TABLE "account_pinned_devices" (
	"user_id" text NOT NULL,
	"device_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "account_pinned_devices_user_id_device_id_pk" PRIMARY KEY("user_id","device_id")
);
--> statement-breakpoint
ALTER TABLE "account_pinned_devices" ADD CONSTRAINT "account_pinned_devices_user_id_local_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."local_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_pinned_devices" ADD CONSTRAINT "account_pinned_devices_device_id_servers_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_account_pinned_devices_device" ON "account_pinned_devices" USING btree ("device_id");
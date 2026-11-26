CREATE TABLE "assistant_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"user_id" text,
	"customer_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"secret" text NOT NULL,
	"key_hint" text NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "assistant_keys_scope_check" CHECK (scope IN ('organization','personal','customer')),
	CONSTRAINT "assistant_keys_user_check" CHECK ((scope = 'personal') = (user_id IS NOT NULL)),
	CONSTRAINT "assistant_keys_customer_check" CHECK ((scope = 'customer') = (customer_id IS NOT NULL)),
	CONSTRAINT "assistant_keys_provider_check" CHECK (provider IN ('anthropic','openai')),
	CONSTRAINT "assistant_keys_model_check" CHECK (length(model) BETWEEN 1 AND 100),
	CONSTRAINT "assistant_keys_secret_check" CHECK (secret <> ''),
	CONSTRAINT "assistant_keys_key_hint_check" CHECK (length(key_hint) <= 4)
);
--> statement-breakpoint
CREATE TABLE "assistant_limits" (
	"principal" text NOT NULL,
	"kind" text NOT NULL,
	"attempts" integer NOT NULL,
	"window_at" bigint NOT NULL,
	CONSTRAINT "assistant_limits_principal_kind_pk" PRIMARY KEY("principal","kind"),
	CONSTRAINT "assistant_limits_kind_check" CHECK (kind IN ('question','test'))
);
--> statement-breakpoint
ALTER TABLE "assistant_keys" ADD CONSTRAINT "assistant_keys_user_id_local_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."local_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_keys" ADD CONSTRAINT "assistant_keys_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_assistant_keys_organization" ON "assistant_keys" USING btree ("scope") WHERE scope = 'organization';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_assistant_keys_user" ON "assistant_keys" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_assistant_keys_customer" ON "assistant_keys" USING btree ("customer_id");
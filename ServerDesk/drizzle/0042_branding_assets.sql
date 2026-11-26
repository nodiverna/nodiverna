CREATE TABLE "branding_assets" (
	"customer_id" text,
	"slot" text NOT NULL,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"size" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"sha256" text NOT NULL,
	"updated_at" bigint NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "branding_assets_slot" CHECK (slot IN ('light','dark','icon')),
	CONSTRAINT "branding_assets_icon_portal" CHECK (slot <> 'icon' OR customer_id IS NULL),
	CONSTRAINT "branding_assets_not_default_customer" CHECK (customer_id IS NULL OR customer_id <> '00000000-0000-4000-8000-000000000100'),
	CONSTRAINT "branding_assets_content_type" CHECK (content_type IN ('image/png','image/webp','image/jpeg','image/svg+xml')),
	CONSTRAINT "branding_assets_size" CHECK (size = octet_length(data) AND size BETWEEN 1 AND 2097152 AND (slot <> 'icon' OR size <= 262144)),
	CONSTRAINT "branding_assets_dimensions" CHECK (width > 0 AND height > 0),
	CONSTRAINT "branding_assets_sha256" CHECK (sha256 ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "branding_assets" ADD CONSTRAINT "branding_assets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "branding_assets_owner_slot" ON "branding_assets" USING btree (COALESCE("customer_id",''),"slot");
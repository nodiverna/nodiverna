ALTER TABLE "device_plugin_data" ADD COLUMN "service" text;--> statement-breakpoint
ALTER TABLE "device_plugin_data" ADD CONSTRAINT "device_plugin_data_service_check" CHECK (service IN ('running','stopped'));--> statement-breakpoint
-- Written by hand below this line. The DHCP rows stored before this column get
-- the service state of their read, so the alert rule "DHCP service stopped"
-- sees them at once. A read that is no valid DHCP snapshot keeps NULL.
UPDATE device_plugin_data SET service=data::jsonb->>'service'
 WHERE plugin='dhcp' AND operation='dhcp-read' AND service IS NULL AND data::jsonb->>'service' IN ('running','stopped');

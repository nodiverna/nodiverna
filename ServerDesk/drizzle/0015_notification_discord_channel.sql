ALTER TABLE "notification_channels" DROP CONSTRAINT "notification_channels_type_check";--> statement-breakpoint
ALTER TABLE "notification_deliveries" DROP CONSTRAINT "notification_deliveries_type_check";--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_type_check" CHECK (type IN ('smtp','teams','discord','webhook'));--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_type_check" CHECK (channel_type IN ('smtp','teams','discord','webhook'));
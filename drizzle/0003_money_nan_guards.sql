ALTER TABLE "alert_events" DROP CONSTRAINT "alert_events_positive_ck";--> statement-breakpoint
ALTER TABLE "price_ticks" DROP CONSTRAINT "price_ticks_positive_ck";--> statement-breakpoint
ALTER TABLE "price_ticks" DROP CONSTRAINT "price_ticks_prev_close_positive_ck";--> statement-breakpoint
ALTER TABLE "valuations" DROP CONSTRAINT "valuations_positive_ck";--> statement-breakpoint
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_positive_ck" CHECK ("alert_events"."price" > 0 and "alert_events"."price" <> 'NaN' and "alert_events"."threshold" > 0 and "alert_events"."threshold" <> 'NaN');--> statement-breakpoint
ALTER TABLE "price_ticks" ADD CONSTRAINT "price_ticks_positive_ck" CHECK ("price_ticks"."price" > 0 and "price_ticks"."price" <> 'NaN');--> statement-breakpoint
ALTER TABLE "price_ticks" ADD CONSTRAINT "price_ticks_prev_close_positive_ck" CHECK ("price_ticks"."prev_close" is null or "price_ticks"."prev_close" > 0 and "price_ticks"."prev_close" <> 'NaN');--> statement-breakpoint
ALTER TABLE "valuations" ADD CONSTRAINT "valuations_positive_ck" CHECK ("valuations"."buy_price" > 0 and "valuations"."buy_price" <> 'NaN' and "valuations"."sticker_price" > 0 and "valuations"."sticker_price" <> 'NaN');--> statement-breakpoint
ALTER TABLE "watch_rules" ADD CONSTRAINT "watch_rules_value_positive_ck" CHECK ("watch_rules"."value" is null or "watch_rules"."value" > 0 and "watch_rules"."value" <> 'NaN');
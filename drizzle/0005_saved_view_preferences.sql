ALTER TABLE "saved_views" ADD COLUMN "view" text;--> statement-breakpoint
ALTER TABLE "saved_views" ADD COLUMN "sort" text;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_view_valid" CHECK ("saved_views"."view" in ('all', 'high-intent', 'needs-followup', 'admitted'));--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_sort_valid" CHECK ("saved_views"."sort" in ('intent', 'newest', 'name'));
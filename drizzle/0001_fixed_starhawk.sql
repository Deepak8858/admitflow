CREATE TABLE "connection_routes" (
	"service" text NOT NULL,
	"external_id" text NOT NULL,
	"organization_id" uuid NOT NULL,
	CONSTRAINT "connection_routes_service_external_id_pk" PRIMARY KEY("service","external_id")
);
--> statement-breakpoint
CREATE TABLE "organization_routes" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"workos_id" text,
	CONSTRAINT "organization_routes_workos_id_unique" UNIQUE("workos_id")
);
--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "lead_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "lead_id" uuid;--> statement-breakpoint
ALTER TABLE "connection_routes" ADD CONSTRAINT "connection_routes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_routes" ADD CONSTRAINT "organization_routes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
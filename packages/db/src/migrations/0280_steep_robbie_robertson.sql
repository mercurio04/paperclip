CREATE TABLE "native_permission_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"contract_sha256" text NOT NULL,
	"decision" text NOT NULL,
	"resolver_user_id" text NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"error" text,
	"native_outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "native_permission_decisions" ADD CONSTRAINT "native_permission_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_permission_decisions" ADD CONSTRAINT "native_permission_decisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_permission_decisions" ADD CONSTRAINT "native_permission_decisions_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "native_permission_decisions_run_request_uq" ON "native_permission_decisions" USING btree ("run_id","request_id");--> statement-breakpoint
CREATE INDEX "native_permission_decisions_company_run_idx" ON "native_permission_decisions" USING btree ("company_id","run_id");
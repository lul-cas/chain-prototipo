using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Chain.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AutomationOutbox : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "automation_work_requests",
                schema: "chain",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    kind = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    status = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    instance_id = table.Column<Guid>(type: "uuid", nullable: false),
                    node_id = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    activation = table.Column<int>(type: "integer", nullable: false),
                    cancels_request_id = table.Column<Guid>(type: "uuid", nullable: true),
                    payload = table.Column<string>(type: "jsonb", nullable: true),
                    idempotency_key = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    deadline_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    closed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_automation_work_requests", x => x.id);
                    table.CheckConstraint("ck_automation_work_requests_activation", "activation >= 1");
                    table.CheckConstraint("ck_automation_work_requests_kind", "kind IN ('execute', 'cancel')");
                    table.CheckConstraint("ck_automation_work_requests_shape", "(kind = 'execute' AND payload IS NOT NULL AND idempotency_key IS NOT NULL AND cancels_request_id IS NULL) OR (kind = 'cancel' AND payload IS NULL AND idempotency_key IS NULL AND cancels_request_id IS NOT NULL)");
                    table.CheckConstraint("ck_automation_work_requests_status", "status IN ('pending', 'completed', 'failed', 'cancelled', 'timed_out')");
                    table.ForeignKey(
                        name: "fk_automation_work_requests_automation_work_requests_cancels_r",
                        column: x => x.cancels_request_id,
                        principalSchema: "chain",
                        principalTable: "automation_work_requests",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_automation_work_requests_instances_instance_id",
                        column: x => x.instance_id,
                        principalSchema: "chain",
                        principalTable: "instances",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ix_automation_work_requests_cancels_request_id",
                schema: "chain",
                table: "automation_work_requests",
                column: "cancels_request_id");

            migrationBuilder.CreateIndex(
                name: "ix_automation_work_requests_pending",
                schema: "chain",
                table: "automation_work_requests",
                column: "created_at",
                filter: "status = 'pending'");

            migrationBuilder.CreateIndex(
                name: "ux_automation_work_requests_activation",
                schema: "chain",
                table: "automation_work_requests",
                columns: new[] { "instance_id", "node_id", "activation" },
                unique: true,
                filter: "kind = 'execute'");

            migrationBuilder.CreateIndex(
                name: "ux_automation_work_requests_one_pending_execute",
                schema: "chain",
                table: "automation_work_requests",
                column: "instance_id",
                unique: true,
                filter: "kind = 'execute' AND status = 'pending'");

            // The views Elixir reads (automation-contract.md §2), and its grants when the role exists (§2.3).
            migrationBuilder.Sql("""
                CREATE VIEW chain.automation_dispatch_v1 AS
                SELECT id AS request_id, kind, cancels_request_id, payload, created_at, deadline_at
                FROM chain.automation_work_requests
                WHERE status = 'pending';

                CREATE VIEW chain.automation_secrets_v1 AS
                SELECT name, version, ciphertext, nonce, wrapped_data_key, key_id, allowed_destinations
                FROM chain.automation_secrets;

                DO $$
                BEGIN
                    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chain_automation') THEN
                        GRANT USAGE ON SCHEMA chain TO chain_automation;
                        GRANT SELECT ON chain.automation_dispatch_v1, chain.automation_secrets_v1 TO chain_automation;
                    END IF;
                END $$;
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                DROP VIEW chain.automation_secrets_v1;
                DROP VIEW chain.automation_dispatch_v1;
                """);

            migrationBuilder.DropTable(
                name: "automation_work_requests",
                schema: "chain");
        }
    }
}

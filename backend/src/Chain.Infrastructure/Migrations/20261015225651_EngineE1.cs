using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Chain.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class EngineE1 : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "idempotency_keys",
                schema: "chain",
                columns: table => new
                {
                    actor_id = table.Column<Guid>(type: "uuid", nullable: false),
                    key = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    request_hash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    result_json = table.Column<string>(type: "jsonb", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_idempotency_keys", x => new { x.actor_id, x.key });
                });

            migrationBuilder.CreateTable(
                name: "instances",
                schema: "chain",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    definition_id = table.Column<Guid>(type: "uuid", nullable: false),
                    definition_name = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    version_number = table.Column<int>(type: "integer", nullable: false),
                    requester_id = table.Column<Guid>(type: "uuid", nullable: false),
                    status = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    current_node_id = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    data = table.Column<string>(type: "jsonb", nullable: false),
                    started_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ended_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    event_count = table.Column<int>(type: "integer", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_instances", x => x.id);
                    table.ForeignKey(
                        name: "fk_instances_users_requester_id",
                        column: x => x.requester_id,
                        principalSchema: "chain",
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_instances_workflow_definitions_definition_id",
                        column: x => x.definition_id,
                        principalSchema: "chain",
                        principalTable: "workflow_definitions",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "instance_events",
                schema: "chain",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    sequence = table.Column<int>(type: "integer", nullable: false),
                    instance_id = table.Column<Guid>(type: "uuid", nullable: false),
                    type = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: false),
                    actor_id = table.Column<Guid>(type: "uuid", nullable: true),
                    acted_as_group_id = table.Column<Guid>(type: "uuid", nullable: true),
                    task_id = table.Column<Guid>(type: "uuid", nullable: true),
                    details = table.Column<string>(type: "jsonb", nullable: false),
                    occurred_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_instance_events", x => x.id);
                    table.ForeignKey(
                        name: "fk_instance_events_instances_instance_id",
                        column: x => x.instance_id,
                        principalSchema: "chain",
                        principalTable: "instances",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "instance_participants",
                schema: "chain",
                columns: table => new
                {
                    instance_id = table.Column<Guid>(type: "uuid", nullable: false),
                    actor_id = table.Column<Guid>(type: "uuid", nullable: false),
                    first_assigned_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_instance_participants", x => new { x.instance_id, x.actor_id });
                    table.ForeignKey(
                        name: "fk_instance_participants_instances_instance_id",
                        column: x => x.instance_id,
                        principalSchema: "chain",
                        principalTable: "instances",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "instance_tasks",
                schema: "chain",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    instance_id = table.Column<Guid>(type: "uuid", nullable: false),
                    node_id = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    label = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    kind = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    question = table.Column<string>(type: "text", nullable: true),
                    group_id = table.Column<Guid>(type: "uuid", nullable: true),
                    status = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    assignee_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ended_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    completed_by = table.Column<Guid>(type: "uuid", nullable: true),
                    outcome = table.Column<bool>(type: "boolean", nullable: true),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_instance_tasks", x => x.id);
                    table.ForeignKey(
                        name: "fk_instance_tasks_instances_instance_id",
                        column: x => x.instance_id,
                        principalSchema: "chain",
                        principalTable: "instances",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ix_idempotency_keys_created_at",
                schema: "chain",
                table: "idempotency_keys",
                column: "created_at");

            migrationBuilder.CreateIndex(
                name: "ix_instance_events_instance_id_sequence",
                schema: "chain",
                table: "instance_events",
                columns: new[] { "instance_id", "sequence" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_instance_participants_actor_id",
                schema: "chain",
                table: "instance_participants",
                column: "actor_id");

            migrationBuilder.CreateIndex(
                name: "ix_instance_tasks_group_id_status",
                schema: "chain",
                table: "instance_tasks",
                columns: new[] { "group_id", "status" });

            migrationBuilder.CreateIndex(
                name: "ix_instance_tasks_instance_id_status",
                schema: "chain",
                table: "instance_tasks",
                columns: new[] { "instance_id", "status" });

            migrationBuilder.CreateIndex(
                name: "ix_instances_definition_id_status",
                schema: "chain",
                table: "instances",
                columns: new[] { "definition_id", "status" });

            migrationBuilder.CreateIndex(
                name: "ix_instances_requester_id",
                schema: "chain",
                table: "instances",
                column: "requester_id");

            // The instance timeline is append-only (workflow-engine.md §8).
            migrationBuilder.Sql("""
                CREATE FUNCTION chain.reject_instance_event_change() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    RAISE EXCEPTION 'instance_events is append-only (workflow-engine.md §8)' USING ERRCODE = 'restrict_violation';
                END;
                $$;
                CREATE TRIGGER instance_events_append_only
                    BEFORE UPDATE OR DELETE ON chain.instance_events
                    FOR EACH ROW EXECUTE FUNCTION chain.reject_instance_event_change();
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                DROP TRIGGER IF EXISTS instance_events_append_only ON chain.instance_events;
                DROP FUNCTION IF EXISTS chain.reject_instance_event_change();
                """);

            migrationBuilder.DropTable(
                name: "idempotency_keys",
                schema: "chain");

            migrationBuilder.DropTable(
                name: "instance_events",
                schema: "chain");

            migrationBuilder.DropTable(
                name: "instance_participants",
                schema: "chain");

            migrationBuilder.DropTable(
                name: "instance_tasks",
                schema: "chain");

            migrationBuilder.DropTable(
                name: "instances",
                schema: "chain");
        }
    }
}

using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Chain.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class EngineE2 : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "instance_incidents",
                schema: "chain",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    instance_id = table.Column<Guid>(type: "uuid", nullable: false),
                    node_id = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    code = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: false),
                    message = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    resolved_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    resolved_by = table.Column<Guid>(type: "uuid", nullable: true),
                    resolution = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_instance_incidents", x => x.id);
                    table.ForeignKey(
                        name: "fk_instance_incidents_instances_instance_id",
                        column: x => x.instance_id,
                        principalSchema: "chain",
                        principalTable: "instances",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "instance_submissions",
                schema: "chain",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    instance_id = table.Column<Guid>(type: "uuid", nullable: false),
                    task_id = table.Column<Guid>(type: "uuid", nullable: true),
                    node_id = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    form_id = table.Column<Guid>(type: "uuid", nullable: false),
                    form_version = table.Column<int>(type: "integer", nullable: false),
                    values = table.Column<string>(type: "jsonb", nullable: false),
                    submitted_by = table.Column<Guid>(type: "uuid", nullable: false),
                    submitted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_instance_submissions", x => x.id);
                    table.ForeignKey(
                        name: "fk_instance_submissions_instances_instance_id",
                        column: x => x.instance_id,
                        principalSchema: "chain",
                        principalTable: "instances",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ix_instance_incidents_instance_id",
                schema: "chain",
                table: "instance_incidents",
                column: "instance_id");

            migrationBuilder.CreateIndex(
                name: "ix_instance_submissions_instance_id",
                schema: "chain",
                table: "instance_submissions",
                column: "instance_id");

            // Submissions are history and append-only (FR-023; workflow-engine.md §13.1).
            migrationBuilder.Sql("""
                CREATE FUNCTION chain.reject_instance_submission_change() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    RAISE EXCEPTION 'instance_submissions is append-only (FR-023)' USING ERRCODE = 'restrict_violation';
                END;
                $$;
                CREATE TRIGGER instance_submissions_append_only
                    BEFORE UPDATE OR DELETE ON chain.instance_submissions
                    FOR EACH ROW EXECUTE FUNCTION chain.reject_instance_submission_change();
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                DROP TRIGGER IF EXISTS instance_submissions_append_only ON chain.instance_submissions;
                DROP FUNCTION IF EXISTS chain.reject_instance_submission_change();
                """);

            migrationBuilder.DropTable(
                name: "instance_incidents",
                schema: "chain");

            migrationBuilder.DropTable(
                name: "instance_submissions",
                schema: "chain");
        }
    }
}

using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Chain.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class WorkflowDefinitions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "platform_grants",
                schema: "chain",
                columns: table => new
                {
                    group_id = table.Column<Guid>(type: "uuid", nullable: false),
                    capability = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_platform_grants", x => new { x.group_id, x.capability });
                    table.CheckConstraint("ck_platform_grants_capability", "capability IN ('modeler')");
                    table.ForeignKey(
                        name: "fk_platform_grants_groups_group_id",
                        column: x => x.group_id,
                        principalSchema: "chain",
                        principalTable: "groups",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "workflow_definitions",
                schema: "chain",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    normalized_name = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    description = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    is_active = table.Column<bool>(type: "boolean", nullable: false),
                    draft = table.Column<string>(type: "jsonb", nullable: false),
                    draft_updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    draft_updated_by = table.Column<Guid>(type: "uuid", nullable: false),
                    latest_version = table.Column<int>(type: "integer", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_by = table.Column<Guid>(type: "uuid", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_workflow_definitions", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "workflow_grants",
                schema: "chain",
                columns: table => new
                {
                    definition_id = table.Column<Guid>(type: "uuid", nullable: false),
                    group_id = table.Column<Guid>(type: "uuid", nullable: false),
                    capability = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_workflow_grants", x => new { x.definition_id, x.group_id, x.capability });
                    table.CheckConstraint("ck_workflow_grants_capability", "capability IN ('start', 'view', 'close', 'comment')");
                    table.ForeignKey(
                        name: "fk_workflow_grants_groups_group_id",
                        column: x => x.group_id,
                        principalSchema: "chain",
                        principalTable: "groups",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_workflow_grants_workflow_definitions_definition_id",
                        column: x => x.definition_id,
                        principalSchema: "chain",
                        principalTable: "workflow_definitions",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "workflow_versions",
                schema: "chain",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    definition_id = table.Column<Guid>(type: "uuid", nullable: false),
                    version_number = table.Column<int>(type: "integer", nullable: false),
                    document = table.Column<string>(type: "jsonb", nullable: false),
                    canonical_json = table.Column<string>(type: "text", nullable: false),
                    content_hash = table.Column<string>(type: "character varying(71)", maxLength: 71, nullable: false),
                    published_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    published_by = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_workflow_versions", x => x.id);
                    table.ForeignKey(
                        name: "fk_workflow_versions_workflow_definitions_definition_id",
                        column: x => x.definition_id,
                        principalSchema: "chain",
                        principalTable: "workflow_definitions",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ix_workflow_definitions_normalized_name",
                schema: "chain",
                table: "workflow_definitions",
                column: "normalized_name",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_workflow_grants_group_id",
                schema: "chain",
                table: "workflow_grants",
                column: "group_id");

            migrationBuilder.CreateIndex(
                name: "ix_workflow_versions_definition_id_version_number",
                schema: "chain",
                table: "workflow_versions",
                columns: new[] { "definition_id", "version_number" },
                unique: true);

            // ADR-0004 §2: published versions are append-only; reject any UPDATE or DELETE at the database level.
            migrationBuilder.Sql("""
                CREATE FUNCTION chain.reject_workflow_version_change() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    RAISE EXCEPTION 'workflow_versions is append-only (ADR-0004)' USING ERRCODE = 'restrict_violation';
                END;
                $$;
                CREATE TRIGGER workflow_versions_append_only
                    BEFORE UPDATE OR DELETE ON chain.workflow_versions
                    FOR EACH ROW EXECUTE FUNCTION chain.reject_workflow_version_change();
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                DROP TRIGGER IF EXISTS workflow_versions_append_only ON chain.workflow_versions;
                DROP FUNCTION IF EXISTS chain.reject_workflow_version_change();
                """);

            migrationBuilder.DropTable(
                name: "platform_grants",
                schema: "chain");

            migrationBuilder.DropTable(
                name: "workflow_grants",
                schema: "chain");

            migrationBuilder.DropTable(
                name: "workflow_versions",
                schema: "chain");

            migrationBuilder.DropTable(
                name: "workflow_definitions",
                schema: "chain");
        }
    }
}

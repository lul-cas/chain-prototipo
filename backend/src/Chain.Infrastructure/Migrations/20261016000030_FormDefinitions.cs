using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Chain.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class FormDefinitions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "form_definitions",
                schema: "chain",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    normalized_name = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    description = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
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
                    table.PrimaryKey("pk_form_definitions", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "form_versions",
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
                    table.PrimaryKey("pk_form_versions", x => x.id);
                    table.ForeignKey(
                        name: "fk_form_versions_form_definitions_definition_id",
                        column: x => x.definition_id,
                        principalSchema: "chain",
                        principalTable: "form_definitions",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ix_form_definitions_normalized_name",
                schema: "chain",
                table: "form_definitions",
                column: "normalized_name",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_form_versions_definition_id_version_number",
                schema: "chain",
                table: "form_versions",
                columns: new[] { "definition_id", "version_number" },
                unique: true);

            // Published form versions are append-only (ADR-0004 §2).
            migrationBuilder.Sql("""
                CREATE FUNCTION chain.reject_form_version_change() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    RAISE EXCEPTION 'form_versions is append-only (ADR-0004)' USING ERRCODE = 'restrict_violation';
                END;
                $$;
                CREATE TRIGGER form_versions_append_only
                    BEFORE UPDATE OR DELETE ON chain.form_versions
                    FOR EACH ROW EXECUTE FUNCTION chain.reject_form_version_change();
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                DROP TRIGGER IF EXISTS form_versions_append_only ON chain.form_versions;
                DROP FUNCTION IF EXISTS chain.reject_form_version_change();
                """);

            migrationBuilder.DropTable(
                name: "form_versions",
                schema: "chain");

            migrationBuilder.DropTable(
                name: "form_definitions",
                schema: "chain");
        }
    }
}

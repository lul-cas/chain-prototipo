using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Chain.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class SensitiveKeys : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_workflow_grants_capability",
                schema: "chain",
                table: "workflow_grants");

            migrationBuilder.AddColumn<string[]>(
                name: "sensitive_keys",
                schema: "chain",
                table: "workflow_versions",
                type: "text[]",
                nullable: false,
                defaultValueSql: "'{}'::text[]");

            migrationBuilder.AddCheckConstraint(
                name: "ck_workflow_grants_capability",
                schema: "chain",
                table: "workflow_grants",
                sql: "capability IN ('start', 'view', 'close', 'comment', 'viewsensitive')");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_workflow_grants_capability",
                schema: "chain",
                table: "workflow_grants");

            migrationBuilder.DropColumn(
                name: "sensitive_keys",
                schema: "chain",
                table: "workflow_versions");

            migrationBuilder.AddCheckConstraint(
                name: "ck_workflow_grants_capability",
                schema: "chain",
                table: "workflow_grants",
                sql: "capability IN ('start', 'view', 'close', 'comment')");
        }
    }
}

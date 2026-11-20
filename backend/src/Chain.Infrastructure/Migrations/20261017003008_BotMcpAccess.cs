using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Chain.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class BotMcpAccess : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "mcp_enabled",
                schema: "chain",
                table: "users",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddCheckConstraint(
                name: "ck_users_mcp_bots_only",
                schema: "chain",
                table: "users",
                sql: "kind = 'bot' OR NOT mcp_enabled");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_users_mcp_bots_only",
                schema: "chain",
                table: "users");

            migrationBuilder.DropColumn(
                name: "mcp_enabled",
                schema: "chain",
                table: "users");
        }
    }
}

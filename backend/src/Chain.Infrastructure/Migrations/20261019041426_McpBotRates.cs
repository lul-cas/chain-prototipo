using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Chain.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class McpBotRates : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "mcp_calls_per_minute",
                schema: "chain",
                table: "users",
                type: "integer",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "mcp_rate_windows",
                schema: "chain",
                columns: table => new
                {
                    bot_id = table.Column<Guid>(type: "uuid", nullable: false),
                    window_start = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    calls = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_mcp_rate_windows", x => new { x.bot_id, x.window_start });
                });

            migrationBuilder.AddCheckConstraint(
                name: "ck_users_mcp_rate",
                schema: "chain",
                table: "users",
                sql: "mcp_calls_per_minute IS NULL OR (kind = 'bot' AND mcp_calls_per_minute BETWEEN 1 AND 600)");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "mcp_rate_windows",
                schema: "chain");

            migrationBuilder.DropCheckConstraint(
                name: "ck_users_mcp_rate",
                schema: "chain",
                table: "users");

            migrationBuilder.DropColumn(
                name: "mcp_calls_per_minute",
                schema: "chain",
                table: "users");
        }
    }
}

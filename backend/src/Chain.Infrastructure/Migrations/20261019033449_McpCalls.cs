using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Chain.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class McpCalls : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "mcp_calls",
                schema: "chain",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    bot_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tool = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    outcome = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    duration_ms = table.Column<int>(type: "integer", nullable: false),
                    correlation_id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    idempotency_key = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    client_name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    client_version = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    arguments_sha256 = table.Column<string>(type: "character varying(71)", maxLength: 71, nullable: false),
                    called_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_mcp_calls", x => x.id);
                });

            migrationBuilder.CreateIndex(
                name: "ix_mcp_calls_called_at",
                schema: "chain",
                table: "mcp_calls",
                column: "called_at");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "mcp_calls",
                schema: "chain");
        }
    }
}

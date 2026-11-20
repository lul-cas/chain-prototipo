using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Chain.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AutomationResults : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "automation_results",
                schema: "chain",
                columns: table => new
                {
                    request_id = table.Column<Guid>(type: "uuid", nullable: false),
                    payload_hash = table.Column<string>(type: "character varying(71)", maxLength: 71, nullable: false),
                    response = table.Column<string>(type: "jsonb", nullable: false),
                    received_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_automation_results", x => x.request_id);
                    table.ForeignKey(
                        name: "fk_automation_results_automation_work_requests_request_id",
                        column: x => x.request_id,
                        principalSchema: "chain",
                        principalTable: "automation_work_requests",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "automation_results",
                schema: "chain");
        }
    }
}

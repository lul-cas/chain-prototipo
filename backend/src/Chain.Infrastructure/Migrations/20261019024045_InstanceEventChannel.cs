using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Chain.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class InstanceEventChannel : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "channel",
                schema: "chain",
                table: "instance_events",
                type: "character varying(3)",
                maxLength: 3,
                nullable: true);

            migrationBuilder.AddCheckConstraint(
                name: "ck_instance_events_channel",
                schema: "chain",
                table: "instance_events",
                sql: "channel IN ('ui', 'api', 'mcp')");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_instance_events_channel",
                schema: "chain",
                table: "instance_events");

            migrationBuilder.DropColumn(
                name: "channel",
                schema: "chain",
                table: "instance_events");
        }
    }
}

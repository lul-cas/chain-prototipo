using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Chain.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class DataCorrections : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AlterColumn<int>(
                name: "form_version",
                schema: "chain",
                table: "instance_submissions",
                type: "integer",
                nullable: true,
                oldClrType: typeof(int),
                oldType: "integer");

            migrationBuilder.AlterColumn<Guid>(
                name: "form_id",
                schema: "chain",
                table: "instance_submissions",
                type: "uuid",
                nullable: true,
                oldClrType: typeof(Guid),
                oldType: "uuid");

            migrationBuilder.AddColumn<string>(
                name: "changes",
                schema: "chain",
                table: "instance_submissions",
                type: "jsonb",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "incident_ids",
                schema: "chain",
                table: "instance_submissions",
                type: "jsonb",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "justification",
                schema: "chain",
                table: "instance_submissions",
                type: "character varying(2000)",
                maxLength: 2000,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "kind",
                schema: "chain",
                table: "instance_submissions",
                type: "character varying(20)",
                maxLength: 20,
                nullable: false,
                defaultValue: "submission");

            migrationBuilder.AddCheckConstraint(
                name: "ck_instance_submissions_kind",
                schema: "chain",
                table: "instance_submissions",
                sql: "(kind = 'submission' AND form_id IS NOT NULL AND form_version IS NOT NULL AND justification IS NULL AND incident_ids IS NULL AND changes IS NULL) OR (kind = 'correction' AND form_id IS NULL AND form_version IS NULL AND task_id IS NULL AND justification IS NOT NULL AND incident_ids IS NOT NULL AND changes IS NOT NULL)");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_instance_submissions_kind",
                schema: "chain",
                table: "instance_submissions");

            migrationBuilder.DropColumn(
                name: "changes",
                schema: "chain",
                table: "instance_submissions");

            migrationBuilder.DropColumn(
                name: "incident_ids",
                schema: "chain",
                table: "instance_submissions");

            migrationBuilder.DropColumn(
                name: "justification",
                schema: "chain",
                table: "instance_submissions");

            migrationBuilder.DropColumn(
                name: "kind",
                schema: "chain",
                table: "instance_submissions");

            migrationBuilder.AlterColumn<int>(
                name: "form_version",
                schema: "chain",
                table: "instance_submissions",
                type: "integer",
                nullable: false,
                defaultValue: 0,
                oldClrType: typeof(int),
                oldType: "integer",
                oldNullable: true);

            migrationBuilder.AlterColumn<Guid>(
                name: "form_id",
                schema: "chain",
                table: "instance_submissions",
                type: "uuid",
                nullable: false,
                defaultValue: new Guid("00000000-0000-0000-0000-000000000000"),
                oldClrType: typeof(Guid),
                oldType: "uuid",
                oldNullable: true);
        }
    }
}

using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Chain.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class EngineE3 : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "child_instance_id",
                schema: "chain",
                table: "instances",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "depth",
                schema: "chain",
                table: "instances",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<Guid>(
                name: "parent_instance_id",
                schema: "chain",
                table: "instances",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "parent_node_id",
                schema: "chain",
                table: "instances",
                type: "character varying(200)",
                maxLength: 200,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "ix_instances_parent_instance_id",
                schema: "chain",
                table: "instances",
                column: "parent_instance_id");

            migrationBuilder.AddCheckConstraint(
                name: "ck_instances_parent",
                schema: "chain",
                table: "instances",
                sql: "(parent_instance_id IS NULL) = (parent_node_id IS NULL) AND depth >= 0");

            migrationBuilder.AddForeignKey(
                name: "fk_instances_instances_parent_instance_id",
                schema: "chain",
                table: "instances",
                column: "parent_instance_id",
                principalSchema: "chain",
                principalTable: "instances",
                principalColumn: "id",
                onDelete: ReferentialAction.Restrict);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "fk_instances_instances_parent_instance_id",
                schema: "chain",
                table: "instances");

            migrationBuilder.DropIndex(
                name: "ix_instances_parent_instance_id",
                schema: "chain",
                table: "instances");

            migrationBuilder.DropCheckConstraint(
                name: "ck_instances_parent",
                schema: "chain",
                table: "instances");

            migrationBuilder.DropColumn(
                name: "child_instance_id",
                schema: "chain",
                table: "instances");

            migrationBuilder.DropColumn(
                name: "depth",
                schema: "chain",
                table: "instances");

            migrationBuilder.DropColumn(
                name: "parent_instance_id",
                schema: "chain",
                table: "instances");

            migrationBuilder.DropColumn(
                name: "parent_node_id",
                schema: "chain",
                table: "instances");
        }
    }
}
